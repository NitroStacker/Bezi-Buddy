use std::collections::{HashMap, HashSet};

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use hkdf::Hkdf;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;

const PROTOCOL_VERSION: u8 = 1;
const REPLAY_WINDOW: u64 = 128;
const MAX_INBOUND_PREFIXES: usize = 16;

#[derive(Default)]
struct InboundReplayWindow {
    highest: Option<u64>,
    seen: HashSet<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedFrame {
    pub v: u8,
    pub host_id: String,
    pub connection_id: String,
    pub direction: String,
    pub kind: String,
    pub seq: u64,
    pub nonce: String,
    pub ciphertext: String,
}

pub struct SessionCrypto {
    host_id: String,
    connection_id: String,
    outbound_key: [u8; 32],
    inbound_key: [u8; 32],
    outbound_direction: &'static str,
    inbound_direction: &'static str,
    nonce_prefix: [u8; 4],
    outbound_sequence: u64,
    inbound_windows: HashMap<[u8; 4], InboundReplayWindow>,
}

impl SessionCrypto {
    pub fn derive(
        pair_secret: &str,
        session_salt: &str,
        host_id: &str,
        mobile_device_id: &str,
        connection_id: &str,
    ) -> Result<Self, String> {
        Self::derive_for_role(
            pair_secret,
            session_salt,
            host_id,
            mobile_device_id,
            connection_id,
            true,
        )
    }

    fn derive_for_role(
        pair_secret: &str,
        session_salt: &str,
        host_id: &str,
        mobile_device_id: &str,
        connection_id: &str,
        is_host: bool,
    ) -> Result<Self, String> {
        let secret = URL_SAFE_NO_PAD
            .decode(pair_secret)
            .map_err(|_| "Pair secret is not valid base64url".to_owned())?;
        if secret.len() < 32 {
            return Err("Pair secret must contain at least 256 bits".to_owned());
        }
        let salt = decode_hex_32(session_salt)?;
        let info = format!("bezi-remote/v{PROTOCOL_VERSION}/{host_id}/{mobile_device_id}");
        let hkdf = Hkdf::<Sha256>::new(Some(&salt), &secret);
        let mut material = [0_u8; 64];
        hkdf.expand(info.as_bytes(), &mut material)
            .map_err(|_| "Could not derive session keys".to_owned())?;
        let mut mobile_to_host = [0_u8; 32];
        let mut host_to_mobile = [0_u8; 32];
        mobile_to_host.copy_from_slice(&material[..32]);
        host_to_mobile.copy_from_slice(&material[32..]);
        let mut nonce_prefix = [0_u8; 4];
        rand::rng().fill_bytes(&mut nonce_prefix);
        let (outbound_key, inbound_key, outbound_direction, inbound_direction) = if is_host {
            (
                host_to_mobile,
                mobile_to_host,
                "host-to-mobile",
                "mobile-to-host",
            )
        } else {
            (
                mobile_to_host,
                host_to_mobile,
                "mobile-to-host",
                "host-to-mobile",
            )
        };
        Ok(Self {
            host_id: host_id.to_owned(),
            connection_id: connection_id.to_owned(),
            outbound_key,
            inbound_key,
            outbound_direction,
            inbound_direction,
            nonce_prefix,
            outbound_sequence: 0,
            inbound_windows: HashMap::new(),
        })
    }

    pub fn encrypt(&mut self, kind: &str, payload: &Value) -> Result<EncryptedFrame, String> {
        if !matches!(kind, "control" | "signaling") {
            return Err("Encrypted frame kind is unsupported".to_owned());
        }
        let seq = self.outbound_sequence;
        self.outbound_sequence = self
            .outbound_sequence
            .checked_add(1)
            .ok_or_else(|| "Encrypted frame sequence exhausted".to_owned())?;
        let nonce = make_nonce(self.nonce_prefix, seq);
        let header = EncryptedFrame {
            v: PROTOCOL_VERSION,
            host_id: self.host_id.clone(),
            connection_id: self.connection_id.clone(),
            direction: self.outbound_direction.to_owned(),
            kind: kind.to_owned(),
            seq,
            nonce: STANDARD.encode(nonce),
            ciphertext: String::new(),
        };
        let plain = serde_json::to_vec(payload)
            .map_err(|error| format!("Could not serialize encrypted payload: {error}"))?;
        let cipher = Aes256Gcm::new_from_slice(&self.outbound_key)
            .map_err(|_| "Could not initialize AES-256-GCM".to_owned())?;
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &plain,
                    aad: associated_data(&header).as_bytes(),
                },
            )
            .map_err(|_| "Could not encrypt session payload".to_owned())?;
        Ok(EncryptedFrame {
            ciphertext: STANDARD.encode(ciphertext),
            ..header
        })
    }

    pub fn decrypt(&mut self, frame: &EncryptedFrame) -> Result<Value, String> {
        if frame.v != PROTOCOL_VERSION
            || frame.host_id != self.host_id
            || frame.connection_id != self.connection_id
            || frame.direction != self.inbound_direction
            || !matches!(frame.kind.as_str(), "control" | "signaling")
        {
            return Err("Encrypted frame metadata is invalid".to_owned());
        }
        let nonce = STANDARD
            .decode(&frame.nonce)
            .map_err(|_| "Encrypted frame nonce is invalid".to_owned())?;
        if nonce.len() != 12 {
            return Err("Encrypted frame nonce must be 12 bytes".to_owned());
        }
        if nonce[4..] != frame.seq.to_be_bytes() {
            return Err("Encrypted frame nonce does not match its sequence".to_owned());
        }
        let mut nonce_prefix = [0_u8; 4];
        nonce_prefix.copy_from_slice(&nonce[..4]);
        if self.is_replay(nonce_prefix, frame.seq) {
            return Err("Encrypted frame is replayed or stale".to_owned());
        }
        let ciphertext = STANDARD
            .decode(&frame.ciphertext)
            .map_err(|_| "Encrypted frame ciphertext is invalid".to_owned())?;
        if ciphertext.len() < 16 || ciphertext.len() > 6_000_000 {
            return Err("Encrypted frame ciphertext size is invalid".to_owned());
        }
        let cipher = Aes256Gcm::new_from_slice(&self.inbound_key)
            .map_err(|_| "Could not initialize AES-256-GCM".to_owned())?;
        let plain = cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: associated_data(frame).as_bytes(),
                },
            )
            .map_err(|_| "Encrypted frame authentication failed".to_owned())?;
        let value = serde_json::from_slice(&plain)
            .map_err(|_| "Encrypted payload is not valid JSON".to_owned())?;
        self.accept_sequence(nonce_prefix, frame.seq);
        Ok(value)
    }

    fn is_replay(&self, prefix: [u8; 4], sequence: u64) -> bool {
        self.inbound_windows.get(&prefix).is_some_and(|window| {
            window.seen.contains(&sequence)
                || window.highest.is_some_and(|highest| {
                    highest >= REPLAY_WINDOW && sequence <= highest - REPLAY_WINDOW
                })
        })
    }

    fn accept_sequence(&mut self, prefix: [u8; 4], sequence: u64) {
        if !self.inbound_windows.contains_key(&prefix)
            && self.inbound_windows.len() >= MAX_INBOUND_PREFIXES
        {
            if let Some(oldest_prefix) = self.inbound_windows.keys().next().copied() {
                self.inbound_windows.remove(&oldest_prefix);
            }
        }
        let window = self.inbound_windows.entry(prefix).or_default();
        let highest = window
            .highest
            .map_or(sequence, |value| value.max(sequence));
        window.highest = Some(highest);
        window.seen.insert(sequence);
        if highest >= REPLAY_WINDOW {
            let floor = highest - REPLAY_WINDOW;
            window.seen.retain(|value| *value > floor);
        }
    }
}

fn make_nonce(prefix: [u8; 4], sequence: u64) -> [u8; 12] {
    let mut nonce = [0_u8; 12];
    nonce[..4].copy_from_slice(&prefix);
    nonce[4..].copy_from_slice(&sequence.to_be_bytes());
    nonce
}

fn associated_data(frame: &EncryptedFrame) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}",
        frame.v, frame.host_id, frame.connection_id, frame.direction, frame.kind, frame.seq
    )
}

fn decode_hex_32(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Session salt must be 32 bytes of hexadecimal".to_owned());
    }
    let mut output = [0_u8; 32];
    for (index, target) in output.iter_mut().enumerate() {
        *target = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| "Session salt is invalid".to_owned())?;
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        pair_secret: String,
        session_salt: String,
        host_id: String,
        mobile_device_id: String,
        connection_id: String,
        frame: EncryptedFrame,
        payload: Value,
    }

    fn paired_crypto() -> (SessionCrypto, SessionCrypto) {
        let secret = URL_SAFE_NO_PAD.encode([7_u8; 32]);
        let host = SessionCrypto::derive(
            &secret,
            &"0b".repeat(32),
            "host-00000000-0000-0000-0000-000000000001",
            "mobile-00000000-0000-0000-0000-000000000002",
            "00000000-0000-4000-8000-000000000003",
        )
        .unwrap();
        let mobile = SessionCrypto::derive_for_role(
            &secret,
            &"0b".repeat(32),
            "host-00000000-0000-0000-0000-000000000001",
            "mobile-00000000-0000-0000-0000-000000000002",
            "00000000-0000-4000-8000-000000000003",
            false,
        )
        .unwrap();
        (host, mobile)
    }

    #[test]
    fn encrypted_payload_round_trips_and_replay_is_rejected() {
        let (mut host, mut mobile) = paired_crypto();
        let frame = mobile
            .encrypt("control", &serde_json::json!({ "private": "value" }))
            .unwrap();
        let payload = host.decrypt(&frame).unwrap();
        assert_eq!(payload["private"], "value");
        assert!(host.decrypt(&frame).unwrap_err().contains("replayed"));
    }

    #[test]
    fn a_new_authenticated_nonce_prefix_can_restart_the_sequence() {
        let (mut host, mut first_mobile) = paired_crypto();
        first_mobile.nonce_prefix = [1, 2, 3, 4];
        let first = first_mobile
            .encrypt("control", &serde_json::json!({ "connection": 1 }))
            .unwrap();
        assert_eq!(host.decrypt(&first).unwrap()["connection"], 1);

        let (_, mut reconnected_mobile) = paired_crypto();
        reconnected_mobile.nonce_prefix = [5, 6, 7, 8];
        let reconnected = reconnected_mobile
            .encrypt("control", &serde_json::json!({ "connection": 2 }))
            .unwrap();
        assert_eq!(reconnected.seq, 0);
        assert_eq!(host.decrypt(&reconnected).unwrap()["connection"], 2);
        assert!(host
            .decrypt(&reconnected)
            .unwrap_err()
            .contains("replayed"));
    }

    #[test]
    fn tampering_fails_before_advancing_replay_window() {
        let (mut host, mut mobile) = paired_crypto();
        let mut frame = mobile
            .encrypt("signaling", &serde_json::json!({ "sdp": "private" }))
            .unwrap();
        frame.ciphertext.replace_range(0..1, "A");
        assert!(host.decrypt(&frame).is_err());
    }

    #[test]
    fn decrypts_the_typescript_protocol_fixture() {
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../../packages/protocol/fixtures/e2ee-v1.json"
        ))
        .unwrap();
        let mut host = SessionCrypto::derive(
            &fixture.pair_secret,
            &fixture.session_salt,
            &fixture.host_id,
            &fixture.mobile_device_id,
            &fixture.connection_id,
        )
        .unwrap();
        assert_eq!(host.decrypt(&fixture.frame).unwrap(), fixture.payload);
    }
}
