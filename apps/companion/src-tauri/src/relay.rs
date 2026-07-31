use std::{collections::HashMap, sync::Arc, time::Duration};

use chrono::{DateTime, SecondsFormat, Utc};
use futures_util::{stream::SplitSink, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use url::Url;

use crate::{
    bezi,
    bezi_bridge::{AcpBridge, AcpEvent},
    control::ControlState,
    crypto::{EncryptedFrame, SessionCrypto},
    state::{load_credentials, CredentialEnvelope},
    stream,
    unity_bridge::{UnityRegistry, UnityResult},
};

type HostSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type HostSink = SplitSink<HostSocket, Message>;

#[derive(Debug, Deserialize)]
struct TicketResponse {
    ticket: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum RelayMessage {
    #[serde(rename = "relay.joined")]
    Joined {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "connectionId")]
        connection_id: String,
        #[serde(rename = "sessionSalt")]
        session_salt: String,
    },
    #[serde(rename = "relay.frame")]
    Frame {
        #[serde(rename = "senderDeviceId")]
        sender_device_id: String,
        frame: EncryptedFrame,
    },
    #[serde(rename = "relay.lease")]
    Lease {
        #[serde(rename = "holderDeviceId")]
        holder_device_id: Option<String>,
        #[serde(rename = "expiresAt")]
        expires_at: Option<String>,
    },
    #[serde(rename = "relay.presence")]
    Presence {
        #[serde(rename = "hostOnline")]
        _host_online: bool,
        viewers: u32,
    },
    #[serde(rename = "relay.pong")]
    Pong {
        #[serde(rename = "sentAt")]
        _sent_at: String,
    },
    #[serde(rename = "relay.error")]
    Error { code: String, message: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TicketRequest<'a> {
    device_id: &'a str,
    role: &'static str,
}

pub async fn run_relay_bridge(host_id: String, unity: UnityRegistry, control: Arc<ControlState>) {
    let bezi_bridge = AcpBridge::start();
    let media = stream::MediaManager::new(control.clone());
    let mut retry = Duration::from_secs(1);
    loop {
        match load_credentials(&host_id) {
            Ok(credentials)
                if !credentials.relay_url.is_empty()
                    && !credentials.owner_token.is_empty()
                    && credentials
                        .pairings
                        .iter()
                        .any(|pairing| pairing.mobile_device_id.is_some()) =>
            {
                match run_once(
                    &host_id,
                    credentials,
                    &unity,
                    &bezi_bridge,
                    &control,
                    &media,
                )
                .await
                {
                    Ok(()) => retry = Duration::from_secs(1),
                    Err(error) => {
                        tracing::warn!(%error, "relay session disconnected");
                    }
                }
            }
            _ => {}
        }
        control.disarm();
        media.stop_all();
        tokio::time::sleep(retry).await;
        retry = (retry * 2).min(Duration::from_secs(5));
    }
}

async fn run_once(
    host_id: &str,
    credentials: CredentialEnvelope,
    unity: &UnityRegistry,
    bezi_bridge: &AcpBridge,
    control: &Arc<ControlState>,
    media: &stream::MediaManager,
) -> Result<(), String> {
    let ticket = request_ticket(host_id, &credentials).await?;
    let socket_url = socket_url(&credentials.relay_url, host_id, &ticket)?;
    let (socket, _) = connect_async(socket_url.as_str())
        .await
        .map_err(|error| format!("Could not connect to relay WebSocket: {error}"))?;
    let (mut sink, mut stream) = socket.split();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    let mut unity_results = unity.subscribe_results();
    let mut bezi_events = bezi_bridge.subscribe();
    let mut media_events = media.subscribe();
    let mut cryptos: HashMap<String, SessionCrypto> = HashMap::new();
    let mut pending_unity: HashMap<String, String> = HashMap::new();
    let mut pending_bezi: HashMap<String, String> = HashMap::new();
    let mut connection: Option<(String, String)> = None;

    loop {
        tokio::select! {
            incoming = stream.next() => {
                let incoming = incoming
                    .ok_or_else(|| "Relay closed the WebSocket".to_owned())?
                    .map_err(|error| format!("Relay WebSocket failed: {error}"))?;
                match incoming {
                    Message::Text(text) => {
                        let message: RelayMessage = serde_json::from_str(&text)
                            .map_err(|_| "Relay returned an invalid protocol message".to_owned())?;
                        match message {
                            RelayMessage::Joined {
                                device_id,
                                connection_id,
                                session_salt,
                            } => {
                                if device_id != host_id {
                                    return Err("Relay joined with the wrong host identity".to_owned());
                                }
                                connection = Some((connection_id, session_salt));
                            }
                            RelayMessage::Frame { sender_device_id, frame } => {
                                let (connection_id, session_salt) = connection
                                    .as_ref()
                                    .ok_or_else(|| "Relay sent a frame before joining".to_owned())?;
                                let crypto = crypto_for_device(
                                    &mut cryptos,
                                    &credentials,
                                    host_id,
                                    &sender_device_id,
                                    connection_id,
                                    session_salt,
                                )?;
                                let payload = crypto.decrypt(&frame)?;
                                let response = dispatch_payload(
                                    payload,
                                    &sender_device_id,
                                    unity,
                                    bezi_bridge,
                                    control,
                                    media,
                                    &mut pending_unity,
                                    &mut pending_bezi,
                                ).await;
                                if let Some(response) = response {
                                    send_encrypted(
                                        &mut sink,
                                        &sender_device_id,
                                        crypto,
                                        frame.kind.as_str(),
                                        &response,
                                    ).await?;
                                }
                            }
                            RelayMessage::Lease { holder_device_id, expires_at } => {
                                if holder_device_id.is_some() {
                                    let duration = expires_at
                                        .as_deref()
                                        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                                        .map(|deadline| {
                                            (deadline.with_timezone(&Utc) - Utc::now())
                                                .to_std()
                                                .unwrap_or_default()
                                        })
                                        .unwrap_or_default();
                                    if duration > Duration::ZERO {
                                        control.arm(duration);
                                    } else {
                                        control.disarm();
                                    }
                                } else {
                                    control.disarm();
                                }
                            }
                            RelayMessage::Presence { viewers, .. } => {
                                if viewers == 0 {
                                    control.disarm();
                                    media.stop_all();
                                }
                            }
                            RelayMessage::Pong { .. } => {}
                            RelayMessage::Error { code, message } => {
                                if code == "recipient_offline" {
                                    control.disarm();
                                    media.stop_all();
                                    continue;
                                }
                                return Err(format!("Relay rejected the session ({code}): {message}"));
                            }
                        }
                    }
                    Message::Close(_) => return Ok(()),
                    Message::Ping(value) => sink
                        .send(Message::Pong(value))
                        .await
                        .map_err(|error| format!("Could not answer relay ping: {error}"))?,
                    _ => {}
                }
            }
            result = unity_results.recv() => {
                match result {
                    Ok(result) => {
                        if let Some(device_id) = pending_unity.remove(&result.request_id) {
                            if let Some(crypto) = cryptos.get_mut(&device_id) {
                                let payload = unity_result_payload(result);
                                send_encrypted(
                                    &mut sink,
                                    &device_id,
                                    crypto,
                                    "control",
                                    &payload,
                                ).await?;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        pending_unity.clear();
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {}
                }
            }
            event = bezi_events.recv() => {
                match event {
                    Ok(event) => {
                        forward_bezi_event(
                            &mut sink,
                            event,
                            &mut pending_bezi,
                            &mut cryptos,
                        ).await?;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        pending_bezi.clear();
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {}
                }
            }
            event = media_events.recv() => {
                match event {
                    Ok(event) => {
                        if let Some(crypto) = cryptos.get_mut(&event.device_id) {
                            let device_id = event.device_id.clone();
                            send_encrypted(
                                &mut sink,
                                &device_id,
                                crypto,
                                "signaling",
                                &event.payload(),
                            ).await?;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        media.stop_all();
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {}
                }
            }
            _ = heartbeat.tick() => {
                sink.send(Message::Text(
                    json!({
                        "type": "relay.ping",
                        "sentAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
                    })
                        .to_string()
                        .into(),
                ))
                .await
                .map_err(|error| format!("Could not send relay heartbeat: {error}"))?;
            }
        }
    }
}

async fn request_ticket(host_id: &str, credentials: &CredentialEnvelope) -> Result<String, String> {
    let relay = Url::parse(&credentials.relay_url)
        .map_err(|error| format!("Stored relay URL is invalid: {error}"))?;
    let endpoint = relay
        .join(&format!("/v1/hosts/{host_id}/session-ticket"))
        .map_err(|error| format!("Stored relay URL is invalid: {error}"))?;
    let response = reqwest::Client::new()
        .post(endpoint)
        .bearer_auth(&credentials.owner_token)
        .json(&TicketRequest {
            device_id: host_id,
            role: "host",
        })
        .send()
        .await
        .map_err(|error| format!("Could not request a relay session ticket: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Relay rejected the host session ticket ({})",
            response.status()
        ));
    }
    response
        .json::<TicketResponse>()
        .await
        .map(|value| value.ticket)
        .map_err(|_| "Relay session ticket response is invalid".to_owned())
}

fn socket_url(relay_url: &str, host_id: &str, ticket: &str) -> Result<Url, String> {
    let mut url = Url::parse(relay_url)
        .and_then(|url| url.join(&format!("/v1/hosts/{host_id}/connect")))
        .map_err(|error| format!("Stored relay URL is invalid: {error}"))?;
    url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
        .map_err(|_| "Stored relay URL has an unsupported scheme".to_owned())?;
    url.query_pairs_mut().append_pair("ticket", ticket);
    Ok(url)
}

fn crypto_for_device<'a>(
    cryptos: &'a mut HashMap<String, SessionCrypto>,
    credentials: &CredentialEnvelope,
    host_id: &str,
    device_id: &str,
    connection_id: &str,
    session_salt: &str,
) -> Result<&'a mut SessionCrypto, String> {
    if !cryptos.contains_key(device_id) {
        let pairing = credentials
            .pairings
            .iter()
            .find(|pairing| pairing.mobile_device_id.as_deref() == Some(device_id))
            .ok_or_else(|| "Encrypted frame came from an unpaired device".to_owned())?;
        let crypto = SessionCrypto::derive(
            &pairing.pair_secret,
            session_salt,
            host_id,
            device_id,
            connection_id,
        )?;
        cryptos.insert(device_id.to_owned(), crypto);
    }
    cryptos
        .get_mut(device_id)
        .ok_or_else(|| "Encrypted session state is unavailable".to_owned())
}

async fn dispatch_payload(
    payload: Value,
    device_id: &str,
    unity: &UnityRegistry,
    bezi_bridge: &AcpBridge,
    control: &Arc<ControlState>,
    media: &stream::MediaManager,
    pending_unity: &mut HashMap<String, String>,
    pending_bezi: &mut HashMap<String, String>,
) -> Option<Value> {
    let request_id = payload.get("requestId")?.as_str()?.to_owned();
    let message_type = payload.get("type")?.as_str()?;
    let body = payload.get("body").cloned().unwrap_or_else(|| json!({}));

    if message_type == "system.hello" {
        let bezi = bezi::status();
        let instances = unity.snapshot().await;
        let stream = stream::probe();
        let capabilities = advertised_capabilities(bezi.connected, !instances.is_empty(), &stream);
        return Some(json!({
            "v": 1,
            "requestId": request_id,
            "type": "system.capabilities",
            "body": {
                "companionVersion": env!("CARGO_PKG_VERSION"),
                "capabilities": capabilities,
                "bezi": bezi,
                "beziWorkspace": bezi::workspace_snapshot(),
                "unity": { "instances": instances },
                "stream": stream
            }
        }));
    }

    if message_type == "unity.instances.list" {
        return Some(json!({
            "v": 1,
            "requestId": request_id,
            "type": "unity.instances",
            "body": { "instances": unity.snapshot().await }
        }));
    }

    if message_type == "bezi.catalog.get" {
        let complete_pages = body
            .get("completePages")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let result =
            tokio::task::spawn_blocking(move || bezi::workspace_snapshot_with_ui(complete_pages))
                .await;
        return Some(match result {
            Ok(workspace)
                if !complete_pages
                    || workspace.pointer("/ui/pagesComplete").and_then(Value::as_bool)
                        == Some(true) =>
            {
                json!({
                "v": 1,
                "requestId": request_id,
                "type": "bezi.catalog",
                "body": { "workspace": workspace }
                })
            }
            Ok(_) => bezi_error(
                &request_id,
                "page_scan_incomplete",
                "Bezi could not inspect every page. Keep the desktop Pages section visible and try again.",
            ),
            Err(error) => bezi_error(
                &request_id,
                "catalog_unavailable",
                &format!("The Bezi catalog task failed: {error}"),
            ),
        });
    }

    if message_type == "stream.start" {
        let target = body.get("target").and_then(Value::as_str).unwrap_or("bezi");
        let process_id = match target {
            "bezi" => bezi::read_descriptor().map(|descriptor| descriptor.pid),
            "unity" => {
                let instance_id = body
                    .get("instanceId")
                    .and_then(Value::as_str)
                    .unwrap_or("active");
                unity.process_id_for(instance_id).await
            }
            _ => Err("The requested stream target is unsupported".to_owned()),
        };
        let result = process_id.and_then(|process_id| {
            media.start(
                device_id,
                &request_id,
                process_id,
                stream::StreamPreset::parse(body.get("preset").and_then(Value::as_str)),
            )
        });
        return Some(match result {
            Ok(()) => json!({
                "v": 1,
                "requestId": request_id,
                "type": "stream.starting",
                "body": { "target": target }
            }),
            Err(message) => stream_error(&request_id, "stream_start_failed", &message),
        });
    }

    if message_type == "stream.answer" {
        let sdp = body
            .pointer("/sdp/sdp")
            .and_then(Value::as_str)
            .or_else(|| body.get("sdp").and_then(Value::as_str));
        let result = sdp
            .ok_or_else(|| "The viewer SDP answer is missing".to_owned())
            .and_then(|sdp| media.set_answer(device_id, sdp));
        return Some(match result {
            Ok(()) => json!({
                "v": 1,
                "requestId": request_id,
                "type": "stream.answer.accepted",
                "body": {}
            }),
            Err(message) => stream_error(&request_id, "answer_rejected", &message),
        });
    }

    if message_type == "stream.ice" {
        let candidate = body.get("candidate").unwrap_or(&body);
        let value = candidate.get("candidate").and_then(Value::as_str);
        let index = candidate
            .get("sdpMLineIndex")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(0);
        let result = value
            .ok_or_else(|| "The viewer ICE candidate is missing".to_owned())
            .and_then(|candidate| media.add_ice_candidate(device_id, index, candidate));
        return Some(match result {
            Ok(()) => json!({
                "v": 1,
                "requestId": request_id,
                "type": "stream.ice.accepted",
                "body": {}
            }),
            Err(message) => stream_error(&request_id, "ice_rejected", &message),
        });
    }

    if message_type == "stream.stop" {
        media.stop(device_id);
        return Some(json!({
            "v": 1,
            "requestId": request_id,
            "type": "stream.stopped",
            "body": {}
        }));
    }

    if let Some((action, command_body)) = unity_command(message_type, &body, &payload) {
        let instance_id = body
            .get("instanceId")
            .and_then(Value::as_str)
            .unwrap_or("active");
        match unity
            .send_command(instance_id, &request_id, action, &command_body)
            .await
        {
            Ok(_) => {
                pending_unity.insert(request_id.clone(), device_id.to_owned());
                return Some(json!({
                    "v": 1,
                    "requestId": request_id,
                    "type": "unity.command.accepted",
                    "body": { "action": action }
                }));
            }
            Err(error) => {
                return Some(json!({
                    "v": 1,
                    "requestId": request_id,
                    "type": "unity.error",
                    "body": { "code": "unity_unavailable", "message": error }
                }));
            }
        }
    }

    if message_type == "bezi.page.get" {
        let page_id = body.get("pageId").and_then(Value::as_str)?.to_owned();
        let ancestor_ids = body
            .get("ancestorIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let result =
            tokio::task::spawn_blocking(move || crate::bezi_ui::read_page(&page_id, &ancestor_ids))
                .await
                .map_err(|error| format!("Bezi page task failed: {error}"))
                .and_then(|result| result);
        return Some(match result {
            Ok(page) => json!({
                "v": 1,
                "requestId": request_id,
                "type": "bezi.page.content",
                "body": page
            }),
            Err(error) => bezi_error(&request_id, "page_unavailable", &error),
        });
    }

    if message_type == "bezi.workspace.activate" {
        let workspace_id = body.get("workspaceId").and_then(Value::as_str)?.to_owned();
        let label = body.get("label").and_then(Value::as_str)?.to_owned();
        let response_workspace_id = workspace_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            crate::bezi_ui::activate_workspace(&workspace_id, &label)
        })
        .await
        .map_err(|error| format!("Bezi workspace task failed: {error}"))
        .and_then(|result| result);
        return Some(match result {
            Ok(()) => json!({
                "v": 1,
                "requestId": request_id,
                "type": "bezi.workspace.activated",
                "body": { "workspaceId": response_workspace_id }
            }),
            Err(error) => bezi_error(&request_id, "ui_action_failed", &error),
        });
    }

    if message_type == "bezi.thread.activate" {
        let session_id = body.get("sessionId").and_then(Value::as_str)?.to_owned();
        let thread_id = body
            .get("threadId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let title = body.get("title").and_then(Value::as_str)?.to_owned();
        let workspace_id = body
            .get("workspaceId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let workspace_label = body
            .get("workspaceLabel")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let response_session_id = session_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            crate::bezi_ui::activate_thread(
                &session_id,
                thread_id.as_deref(),
                &title,
                workspace_id.as_deref(),
                workspace_label.as_deref(),
            )
        })
        .await
        .map_err(|error| format!("Bezi thread task failed: {error}"))
        .and_then(|result| result);
        return Some(match result {
            Ok(()) => json!({
                "v": 1,
                "requestId": request_id,
                "type": "bezi.thread.activated",
                "body": { "sessionId": response_session_id }
            }),
            Err(error) => bezi_error(&request_id, "ui_action_failed", &error),
        });
    }

    if message_type == "bezi.ui.activate" {
        if !control.is_armed() {
            return Some(bezi_error(
                &request_id,
                "control_disarmed",
                "Hold Take Control before changing the Bezi desktop view.",
            ));
        }
        let item_id = body.get("itemId").and_then(Value::as_str)?.to_owned();
        let result = tokio::task::spawn_blocking(move || crate::bezi_ui::activate(&item_id))
            .await
            .map_err(|error| format!("Bezi UI task failed: {error}"))
            .and_then(|result| result);
        return Some(match result {
            Ok(()) => json!({
                "v": 1,
                "requestId": request_id,
                "type": "bezi.ui.activated",
                "body": {}
            }),
            Err(error) => bezi_error(&request_id, "ui_action_failed", &error),
        });
    }

    if message_type == "bezi.ui.folder.set" {
        let item_id = body.get("itemId").and_then(Value::as_str)?.to_owned();
        let expanded = body.get("expanded").and_then(Value::as_bool)?;
        let response_item_id = item_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            crate::bezi_ui::set_folder_expanded(&item_id, expanded)
        })
        .await
        .map_err(|error| format!("Bezi UI task failed: {error}"))
        .and_then(|result| result);
        return Some(match result {
            Ok(()) => json!({
                "v": 1,
                "requestId": request_id,
                "type": "bezi.ui.folder.changed",
                "body": {
                    "itemId": response_item_id,
                    "expanded": expanded
                }
            }),
            Err(error) => bezi_error(&request_id, "ui_action_failed", &error),
        });
    }

    if message_type == "bezi.permission.resolve" {
        let acp_id = body.get("acpRequestId")?.clone();
        let result = body.get("result").cloned().unwrap_or_else(|| {
            json!({
                "outcome": {
                    "outcome": "selected",
                    "optionId": body.get("option").and_then(Value::as_str).unwrap_or("deny")
                }
            })
        });
        return Some(match bezi_bridge.respond(acp_id, result).await {
            Ok(()) => json!({
                "v": 1,
                "requestId": request_id,
                "type": "bezi.permission.accepted",
                "body": {}
            }),
            Err(error) => bezi_error(&request_id, "acp_unavailable", &error),
        });
    }

    if message_type == "remote.input" {
        return Some(match control.apply_remote_input(&body) {
            Ok(()) => json!({
                "v": 1,
                "requestId": request_id,
                "type": "remote.input.ack",
                "body": {}
            }),
            Err(error) => json!({
                "v": 1,
                "requestId": request_id,
                "type": "remote.error",
                "body": { "code": "input_rejected", "message": error }
            }),
        });
    }

    if let Some((method, params)) = bezi_command(message_type, &body) {
        return Some(
            match bezi_bridge.request(&request_id, method, params).await {
                Ok(()) => {
                    pending_bezi.insert(request_id.clone(), device_id.to_owned());
                    json!({
                        "v": 1,
                        "requestId": request_id,
                        "type": "bezi.command.accepted",
                        "body": { "method": method }
                    })
                }
                Err(error) => bezi_error(&request_id, "acp_unavailable", &error),
            },
        );
    }

    Some(json!({
        "v": 1,
        "requestId": request_id,
        "type": "system.error",
        "body": {
            "code": "unsupported_action",
            "message": "This action is not advertised by the connected host."
        }
    }))
}

fn advertised_capabilities(
    bezi_connected: bool,
    unity_connected: bool,
    stream: &stream::StreamStatus,
) -> Vec<&'static str> {
    let mut capabilities = vec!["input.pointer", "input.keyboard"];
    if bezi_connected {
        capabilities.push("bezi.native");
    }
    if unity_connected {
        capabilities.push("unity.semantic");
    }
    capabilities.extend_from_slice(stream.capabilities());
    capabilities
}

fn bezi_command<'a>(message_type: &str, body: &'a Value) -> Option<(&'a str, Value)> {
    match message_type {
        "bezi.session.list" => Some(("session/list", body.clone())),
        "bezi.session.new" => Some((
            "session/new",
            json!({
                "cwd": body.get("cwd")?,
                "mcpServers": body.get("mcpServers").cloned().unwrap_or_else(|| json!([])),
            }),
        )),
        "bezi.session.load" => Some(("session/load", body.clone())),
        "bezi.session.resume" => Some(("session/resume", body.clone())),
        "bezi.session.close" => Some(("session/close", body.clone())),
        "bezi.session.delete" => Some(("session/delete", body.clone())),
        "bezi.session.cancel" => Some(("session/cancel", body.clone())),
        "bezi.session.prompt" => {
            let text = body.get("text")?.as_str()?;
            let mut prompt = vec![json!({ "type": "text", "text": text })];
            if let Some(attachments) = body.get("attachments").and_then(Value::as_array) {
                prompt.extend(attachments.iter().cloned());
            }
            Some((
                "session/prompt",
                json!({ "sessionId": body.get("sessionId")?, "prompt": prompt }),
            ))
        }
        "bezi.session.set_mode" => Some(("session/set_mode", body.clone())),
        "bezi.session.set_model" => Some(("session/set_model", body.clone())),
        "bezi.session.set_config_option" => Some(("session/set_config_option", body.clone())),
        "bezi.acp.request" => Some((
            body.get("method")?.as_str()?,
            body.get("params").cloned().unwrap_or_else(|| json!({})),
        )),
        _ => None,
    }
}

fn bezi_error(request_id: &str, code: &str, message: &str) -> Value {
    json!({
        "v": 1,
        "requestId": request_id,
        "type": "bezi.error",
        "body": { "code": code, "message": message }
    })
}

fn stream_error(request_id: &str, code: &str, message: &str) -> Value {
    json!({
        "v": 1,
        "requestId": request_id,
        "type": "stream.error",
        "body": { "code": code, "message": message }
    })
}

fn unity_command(
    message_type: &str,
    body: &Value,
    payload: &Value,
) -> Option<(&'static str, Value)> {
    match message_type {
        "unity.hierarchy.snapshot" => Some(("hierarchy.snapshot", json!({}))),
        "unity.assets.snapshot" => Some(("assets.snapshot", json!({}))),
        "unity.selection.set" => Some((
            "selection.set",
            json!({ "targetId": body.get("targetId")? }),
        )),
        "unity.inspector.snapshot" => Some((
            "inspector.snapshot",
            json!({ "targetId": body.get("targetId")? }),
        )),
        "unity.property.apply" => {
            let value = normalize_unity_value(body.get("value")?)?;
            Some((
                "property.apply",
                json!({
                    "targetId": body.get("targetId")?,
                    "propertyPath": body.get("propertyPath")?,
                    "value": value,
                    "expectedRevision": payload.get("expectedRevision")?,
                    "idempotencyKey": payload.get("idempotencyKey")?,
                }),
            ))
        }
        "unity.play" | "unity.stop" | "unity.pause" | "unity.resume" | "unity.step" => Some((
            "play.control",
            json!({ "operation": message_type.trim_start_matches("unity.") }),
        )),
        _ => None,
    }
}

fn normalize_unity_value(value: &Value) -> Option<Value> {
    if value.get("kind").is_some() {
        return Some(value.clone());
    }
    let kind = value.get("type")?.as_str()?;
    let raw = value.get("value")?;
    let mut output = Map::new();
    output.insert(
        "kind".to_owned(),
        Value::String(
            match kind {
                "float" => "number",
                other => other,
            }
            .to_owned(),
        ),
    );
    output.insert("components".to_owned(), json!([]));
    match kind {
        "float" => output.insert("numberValue".to_owned(), raw.clone()),
        "integer" | "enum" => output.insert("intValue".to_owned(), raw.clone()),
        "boolean" => output.insert("boolValue".to_owned(), raw.clone()),
        "string" => output.insert("stringValue".to_owned(), raw.clone()),
        "objectReference" => output.insert("objectId".to_owned(), raw.clone()),
        "color" | "vector2" | "vector3" | "vector4" | "rect" | "bounds" | "quaternion" => {
            output.insert("components".to_owned(), raw.clone())
        }
        _ => return None,
    };
    Some(Value::Object(output))
}

fn unity_result_payload(result: UnityResult) -> Value {
    let body = result
        .body_json
        .as_deref()
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    json!({
        "v": 1,
        "requestId": result.request_id,
        "type": "unity.result",
        "body": {
            "instanceId": result.instance_id,
            "success": result.success,
            "result": body,
            "errorCode": result.error_code,
            "message": result.message,
        }
    })
}

async fn forward_bezi_event(
    sink: &mut HostSink,
    event: AcpEvent,
    pending: &mut HashMap<String, String>,
    cryptos: &mut HashMap<String, SessionCrypto>,
) -> Result<(), String> {
    let request_id = event
        .request_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let payload = json!({
        "v": 1,
        "requestId": request_id,
        "type": if event.request_id.is_some() {
            "bezi.acp.response"
        } else {
            "bezi.acp.event"
        },
        "body": { "message": event.value }
    });
    let recipients = event
        .request_id
        .as_ref()
        .and_then(|id| pending.remove(id))
        .map(|id| vec![id])
        .unwrap_or_else(|| cryptos.keys().cloned().collect());
    for device_id in recipients {
        if let Some(crypto) = cryptos.get_mut(&device_id) {
            send_encrypted(sink, &device_id, crypto, "control", &payload).await?;
        }
    }
    Ok(())
}

async fn send_encrypted(
    sink: &mut HostSink,
    device_id: &str,
    crypto: &mut SessionCrypto,
    kind: &str,
    payload: &Value,
) -> Result<(), String> {
    let frame = crypto.encrypt(kind, payload)?;
    sink.send(Message::Text(
        json!({
            "type": "relay.frame",
            "recipientDeviceId": device_id,
            "frame": frame,
        })
        .to_string()
        .into(),
    ))
    .await
    .map_err(|error| format!("Could not send encrypted relay frame: {error}"))
}
