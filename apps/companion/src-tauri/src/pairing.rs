use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{Duration, SecondsFormat, Utc};
use rand::RngCore;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use uuid::Uuid;

use crate::state::{load_credentials, save_credentials, CompanionState, StoredPairing};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingResult {
    pub qr_payload: String,
    pub pairing_id: String,
    pub expires_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatus {
    pub state: String,
    pub mobile_device_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingQr {
    v: u8,
    relay_url: String,
    pairing_id: String,
    host_id: String,
    host_name: String,
    claim_code: String,
    pair_secret: String,
    expires_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartPairingRequest {
    pairing_id: String,
    host_id: String,
    host_name: String,
    code_hash: String,
    expires_at: String,
    companion_version: String,
}

#[derive(Debug, Deserialize)]
struct ErrorEnvelope {
    error: Option<ApiError>,
}

#[derive(Debug, Deserialize)]
struct ApiError {
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingRecord {
    expires_at: String,
    claimed_by: Option<String>,
    claimed_at: Option<String>,
}

#[tauri::command]
pub async fn create_pairing(
    relay_url: String,
    owner_token: String,
    state: State<'_, CompanionState>,
) -> Result<PairingResult, String> {
    if owner_token.len() < 32 {
        return Err("Development owner token must be at least 32 characters".to_owned());
    }
    let relay = normalize_relay_url(&relay_url)?;
    let pairing_id = Uuid::new_v4().to_string();
    let claim_code = random_secret();
    let pair_secret = random_secret();
    let expires_at =
        (Utc::now() + Duration::minutes(5)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let host_name = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows PC".to_owned());
    let code_hash = URL_SAFE_NO_PAD.encode(Sha256::digest(claim_code.as_bytes()));

    let body = StartPairingRequest {
        pairing_id: pairing_id.clone(),
        host_id: state.host_id.clone(),
        host_name: host_name.clone(),
        code_hash,
        expires_at: expires_at.clone(),
        companion_version: env!("CARGO_PKG_VERSION").to_owned(),
    };
    let endpoint = relay
        .join("/v1/pairings")
        .map_err(|error| format!("Relay URL is invalid: {error}"))?;
    let response = reqwest::Client::new()
        .post(endpoint)
        .bearer_auth(&owner_token)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("Could not reach the relay: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let message = response
            .json::<ErrorEnvelope>()
            .await
            .ok()
            .and_then(|value| value.error)
            .and_then(|value| value.message)
            .unwrap_or_else(|| format!("Relay rejected pairing ({status})"));
        return Err(message);
    }

    let mut credentials = load_credentials(&state.host_id).unwrap_or_default();
    credentials.relay_url = relay.as_str().trim_end_matches('/').to_owned();
    credentials.owner_token = owner_token;
    credentials
        .pairings
        .retain(|pairing| pairing.pairing_id != pairing_id);
    credentials.pairings.push(StoredPairing {
        pairing_id: pairing_id.clone(),
        pair_secret: pair_secret.clone(),
        mobile_device_id: None,
        created_at: Utc::now().to_rfc3339(),
    });
    save_credentials(&state.host_id, &credentials)?;
    *state.pending_pairing.lock().await = Some(pairing_id.clone());
    state.set_relay_configured(true);

    let qr = PairingQr {
        v: 1,
        relay_url: credentials.relay_url,
        pairing_id: pairing_id.clone(),
        host_id: state.host_id.clone(),
        host_name,
        claim_code,
        pair_secret,
        expires_at: expires_at.clone(),
    };
    let qr_payload = serde_json::to_string(&qr)
        .map_err(|error| format!("Could not create QR payload: {error}"))?;

    Ok(PairingResult {
        qr_payload,
        pairing_id,
        expires_at,
    })
}

#[tauri::command]
pub async fn get_pairing_status(
    pairing_id: String,
    state: State<'_, CompanionState>,
) -> Result<PairingStatus, String> {
    let mut credentials = load_credentials(&state.host_id)?;
    if !credentials
        .pairings
        .iter()
        .any(|pairing| pairing.pairing_id == pairing_id)
    {
        return Err("Pairing does not belong to this companion".to_owned());
    }
    let relay = normalize_relay_url(&credentials.relay_url)?;
    let endpoint = relay
        .join(&format!("/v1/pairings/{pairing_id}"))
        .map_err(|error| format!("Relay URL is invalid: {error}"))?;
    let response = reqwest::Client::new()
        .get(endpoint)
        .bearer_auth(&credentials.owner_token)
        .send()
        .await
        .map_err(|error| format!("Could not reach the relay: {error}"))?;
    if !response.status().is_success() {
        return Ok(PairingStatus {
            state: "expired".to_owned(),
            mobile_device_id: None,
        });
    }
    let record = response
        .json::<PairingRecord>()
        .await
        .map_err(|error| format!("Relay pairing response is invalid: {error}"))?;
    if let (Some(device_id), Some(_)) = (&record.claimed_by, &record.claimed_at) {
        if let Some(pairing) = credentials
            .pairings
            .iter_mut()
            .find(|pairing| pairing.pairing_id == pairing_id)
        {
            pairing.mobile_device_id = Some(device_id.clone());
        }
        save_credentials(&state.host_id, &credentials)?;
        *state.pending_pairing.lock().await = None;
        return Ok(PairingStatus {
            state: "claimed".to_owned(),
            mobile_device_id: Some(device_id.clone()),
        });
    }
    let expires_at = chrono::DateTime::parse_from_rfc3339(&record.expires_at)
        .map_err(|_| "Relay pairing expiry is invalid".to_owned())?;
    Ok(PairingStatus {
        state: if expires_at < Utc::now() {
            "expired"
        } else {
            "pending"
        }
        .to_owned(),
        mobile_device_id: None,
    })
}

fn normalize_relay_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(|error| format!("Relay URL is invalid: {error}"))?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err("Relay URL must begin with https:// or http://".to_owned());
    }
    if url.scheme() != "https" && !matches!(url.host_str(), Some("127.0.0.1" | "localhost")) {
        return Err("A non-local relay must use HTTPS".to_owned());
    }
    Ok(url)
}

fn random_secret() -> String {
    let mut value = [0_u8; 32];
    rand::rng().fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}
