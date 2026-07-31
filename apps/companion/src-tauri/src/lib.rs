mod bezi;
mod bezi_bridge;
mod bezi_ui;
mod control;
mod crypto;
mod pairing;
mod relay;
mod state;
mod stream;
#[cfg(feature = "native-streaming")]
mod stream_native;
mod unity_bridge;

use std::time::Duration;

use serde::Serialize;
use state::CompanionState;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, State,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicStatus {
    host_id: String,
    bezi_installed: bool,
    bezi_connected: bool,
    bezi_version: Option<String>,
    unity_instances: usize,
    relay_configured: bool,
    control_armed: bool,
    stream: stream::StreamStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProofDefaults {
    relay_url: String,
    owner_token: String,
}

#[tauri::command]
fn get_status(state: State<'_, CompanionState>) -> PublicStatus {
    let bezi = bezi::status();
    PublicStatus {
        host_id: state.host_id.clone(),
        bezi_installed: bezi.installed,
        bezi_connected: bezi.connected,
        bezi_version: bezi.version,
        unity_instances: state.unity.count(),
        relay_configured: state.relay_configured(),
        control_armed: state.control.is_armed(),
        stream: stream::probe(),
    }
}

#[tauri::command]
async fn probe_bezi() -> Result<bezi::AcpSnapshot, String> {
    bezi::probe_acp().await
}

#[tauri::command]
fn disarm_control(state: State<'_, CompanionState>) {
    state.control.disarm();
}

#[tauri::command]
fn get_proof_defaults() -> ProofDefaults {
    ProofDefaults {
        relay_url: std::env::var("BEZI_REMOTE_RELAY_URL").unwrap_or_default(),
        owner_token: std::env::var("BEZI_REMOTE_OWNER_TOKEN").unwrap_or_default(),
    }
}

#[tauri::command]
fn arm_control(state: State<'_, CompanionState>, duration_seconds: u64) -> Result<(), String> {
    if !(5..=60).contains(&duration_seconds) {
        return Err("Control duration must be between 5 and 60 seconds".to_owned());
    }
    state.control.arm(Duration::from_secs(duration_seconds));
    Ok(())
}

#[tauri::command]
async fn list_unity_instances(
    state: State<'_, CompanionState>,
) -> Result<Vec<unity_bridge::UnityInstance>, String> {
    Ok(state.unity.snapshot().await)
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "bezi_remote_companion=info".into()),
        )
        .with_target(false)
        .without_time()
        .init();

    let state = CompanionState::load().expect("companion state must initialize");
    let host_id = state.host_id.clone();
    let unity_registry = state.unity.clone();
    let relay_unity_registry = state.unity.clone();
    let control = state.control.clone();
    let relay_control = state.control.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_proof_defaults,
            pairing::create_pairing,
            pairing::get_pairing_status,
            probe_bezi,
            arm_control,
            list_unity_instances,
            disarm_control
        ])
        .setup(move |app| {
            let start_hidden = std::env::var("BEZI_REMOTE_START_HIDDEN")
                .is_ok_and(|value| matches!(value.as_str(), "1" | "true" | "TRUE"));
            let show = MenuItem::with_id(app, "show", "Open Companion", true, None::<&str>)?;
            let disarm =
                MenuItem::with_id(app, "disarm", "Disarm Remote Control", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &disarm, &quit])?;
            TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Bezi Remote Companion")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "disarm" => {
                        app.state::<CompanionState>().control.disarm();
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            if !start_hidden {
                if let Some(window) = app.get_webview_window("main") {
                    window.show()?;
                    window.set_focus()?;
                }
            }

            tauri::async_runtime::spawn(async move {
                if let Err(error) = unity_bridge::run_pipe_server(unity_registry).await {
                    tracing::error!(%error, "unity bridge stopped");
                }
            });
            tauri::async_runtime::spawn(async move {
                relay::run_relay_bridge(host_id, relay_unity_registry, relay_control).await;
            });
            tauri::async_runtime::spawn(async move {
                loop {
                    if control.is_armed() {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    } else {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Bezi Remote Companion");
}
