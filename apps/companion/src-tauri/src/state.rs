use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use chrono::Utc;
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{control::ControlState, unity_bridge::UnityRegistry};

const CREDENTIAL_SERVICE: &str = "app.beziremote.companion";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CredentialEnvelope {
    pub relay_url: String,
    pub owner_token: String,
    pub pairings: Vec<StoredPairing>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPairing {
    pub pairing_id: String,
    pub pair_secret: String,
    pub mobile_device_id: Option<String>,
    pub created_at: String,
}

pub struct CompanionState {
    pub host_id: String,
    pub unity: UnityRegistry,
    pub control: Arc<ControlState>,
    pub pending_pairing: Mutex<Option<String>>,
    relay_configured: AtomicBool,
}

impl CompanionState {
    pub fn load() -> Result<Self, String> {
        let host_id = load_or_create_host_id()?;
        bootstrap_proof_credentials(&host_id)?;
        let relay_configured = load_credentials(&host_id)
            .map(|value| !value.relay_url.is_empty() && !value.owner_token.is_empty())
            .unwrap_or(false);
        Ok(Self {
            host_id,
            unity: UnityRegistry::default(),
            control: Arc::new(ControlState::default()),
            pending_pairing: Mutex::new(None),
            relay_configured: AtomicBool::new(relay_configured),
        })
    }

    pub fn relay_configured(&self) -> bool {
        self.relay_configured.load(Ordering::Relaxed)
    }

    pub fn set_relay_configured(&self, value: bool) {
        self.relay_configured.store(value, Ordering::Relaxed);
    }
}

fn bootstrap_proof_credentials(host_id: &str) -> Result<(), String> {
    let Some(relay_url) = std::env::var("BEZI_REMOTE_RELAY_URL").ok() else {
        return Ok(());
    };
    let Some(owner_token) = std::env::var("BEZI_REMOTE_OWNER_TOKEN").ok() else {
        return Ok(());
    };
    let Some(pairing_id) = std::env::var("BEZI_REMOTE_PROOF_PAIRING_ID").ok() else {
        return Ok(());
    };
    let Some(pair_secret) = std::env::var("BEZI_REMOTE_PROOF_PAIR_SECRET").ok() else {
        return Ok(());
    };
    let Some(mobile_device_id) = std::env::var("BEZI_REMOTE_PROOF_MOBILE_DEVICE_ID").ok() else {
        return Ok(());
    };
    if owner_token.len() < 32 || pair_secret.len() < 43 {
        return Err("Expo proof credentials failed validation".to_owned());
    }
    save_credentials(
        host_id,
        &CredentialEnvelope {
            relay_url: relay_url.trim_end_matches('/').to_owned(),
            owner_token,
            pairings: vec![StoredPairing {
                pairing_id,
                pair_secret,
                mobile_device_id: Some(mobile_device_id),
                created_at: Utc::now().to_rfc3339(),
            }],
        },
    )
}

pub fn load_credentials(host_id: &str) -> Result<CredentialEnvelope, String> {
    let entry = keyring::Entry::new(CREDENTIAL_SERVICE, host_id)
        .map_err(|error| format!("Could not open Windows Credential Manager: {error}"))?;
    let value = entry
        .get_password()
        .map_err(|error| format!("No stored companion credential: {error}"))?;
    serde_json::from_str(&value)
        .map_err(|error| format!("Stored companion credential is invalid: {error}"))
}

pub fn save_credentials(host_id: &str, envelope: &CredentialEnvelope) -> Result<(), String> {
    let entry = keyring::Entry::new(CREDENTIAL_SERVICE, host_id)
        .map_err(|error| format!("Could not open Windows Credential Manager: {error}"))?;
    let value = serde_json::to_string(envelope)
        .map_err(|error| format!("Could not serialize companion credential: {error}"))?;
    entry
        .set_password(&value)
        .map_err(|error| format!("Could not secure companion credential: {error}"))
}

fn load_or_create_host_id() -> Result<String, String> {
    if let Ok(value) = std::env::var("BEZI_REMOTE_PROOF_HOST_ID") {
        if value.starts_with("host-") && value.len() >= 20 {
            return Ok(value);
        }
        return Err("Expo proof host identity failed validation".to_owned());
    }
    let path = host_id_path()?;
    if let Ok(existing) = fs::read_to_string(&path) {
        let value = existing.trim();
        if value.starts_with("host-") && value.len() >= 20 {
            return Ok(value.to_owned());
        }
    }
    let value = format!("host-{}", Uuid::new_v4());
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create companion data folder: {error}"))?;
    }
    fs::write(&path, &value)
        .map_err(|error| format!("Could not persist companion host identity: {error}"))?;
    Ok(value)
}

fn host_id_path() -> Result<PathBuf, String> {
    ProjectDirs::from("app", "Bezi Remote", "Bezi Remote Companion")
        .map(|dirs| dirs.data_local_dir().join("host-id"))
        .ok_or_else(|| "Windows local application data folder is unavailable".to_owned())
}
