use std::{collections::HashMap, time::Duration};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::{header::SEC_WEBSOCKET_PROTOCOL, HeaderValue},
        Message,
    },
};

use crate::bezi;

#[derive(Debug)]
enum AcpCommand {
    Request {
        request_id: String,
        method: String,
        params: Value,
    },
    Response {
        acp_id: Value,
        result: Value,
    },
}

#[derive(Debug, Clone)]
pub struct AcpEvent {
    pub request_id: Option<String>,
    pub value: Value,
}

#[derive(Clone)]
pub struct AcpBridge {
    commands: mpsc::Sender<AcpCommand>,
    events: broadcast::Sender<AcpEvent>,
}

impl AcpBridge {
    pub fn start() -> Self {
        let (commands, receiver) = mpsc::channel(128);
        let (events, _) = broadcast::channel(512);
        let bridge = Self {
            commands,
            events: events.clone(),
        };
        tokio::spawn(run(receiver, events));
        bridge
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AcpEvent> {
        self.events.subscribe()
    }

    pub async fn request(
        &self,
        request_id: &str,
        method: &str,
        params: Value,
    ) -> Result<(), String> {
        if !is_allowed_method(method) {
            return Err("Bezi ACP method is not allowlisted for remote use".to_owned());
        }
        self.commands
            .send(AcpCommand::Request {
                request_id: request_id.to_owned(),
                method: method.to_owned(),
                params,
            })
            .await
            .map_err(|_| "Bezi ACP bridge is unavailable".to_owned())
    }

    pub async fn respond(&self, acp_id: Value, result: Value) -> Result<(), String> {
        self.commands
            .send(AcpCommand::Response { acp_id, result })
            .await
            .map_err(|_| "Bezi ACP bridge is unavailable".to_owned())
    }
}

async fn run(mut commands: mpsc::Receiver<AcpCommand>, events: broadcast::Sender<AcpEvent>) {
    let mut retry = Duration::from_secs(1);
    loop {
        match run_connection(&mut commands, &events).await {
            Ok(()) => retry = Duration::from_secs(1),
            Err(error) => tracing::debug!(%error, "bezi ACP bridge disconnected"),
        }
        tokio::time::sleep(retry).await;
        retry = (retry * 2).min(Duration::from_secs(5));
    }
}

async fn run_connection(
    commands: &mut mpsc::Receiver<AcpCommand>,
    events: &broadcast::Sender<AcpEvent>,
) -> Result<(), String> {
    let descriptor = bezi::read_descriptor()?;
    let url = format!("ws://127.0.0.1:{}", descriptor.port);
    let mut request = url
        .into_client_request()
        .map_err(|error| format!("Could not build Bezi ACP request: {error}"))?;
    let protocols = format!("bezi-acp.v1, bv.1, token.{}", descriptor.token);
    request.headers_mut().insert(
        SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_str(&protocols)
            .map_err(|_| "Bezi ACP credential contains invalid header data".to_owned())?,
    );
    let (socket, _) = connect_async(request)
        .await
        .map_err(|error| format!("Could not connect to Bezi ACP: {error}"))?;
    let (mut sink, mut stream) = socket.split();
    sink.send(Message::Text(
        json!({
            "jsonrpc": "2.0",
            "id": 0,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                    "elicitation": {}
                },
                "clientInfo": {
                    "name": "bezi-remote",
                    "title": "Bezi Remote",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        })
        .to_string()
        .into(),
    ))
    .await
    .map_err(|error| format!("Could not initialize Bezi ACP: {error}"))?;

    let initialization = tokio::time::timeout(Duration::from_secs(4), stream.next())
        .await
        .map_err(|_| "Bezi ACP initialization timed out".to_owned())?
        .ok_or_else(|| "Bezi ACP closed during initialization".to_owned())?
        .map_err(|error| format!("Bezi ACP initialization failed: {error}"))?;
    let initialization = parse_text(initialization)?;
    if initialization.get("result").is_none() {
        return Err("Bezi ACP rejected initialization".to_owned());
    }
    let _ = events.send(AcpEvent {
        request_id: None,
        value: json!({
            "jsonrpc": "2.0",
            "method": "bezi_remote/initialized",
            "params": initialization.get("result").cloned().unwrap_or(Value::Null)
        }),
    });

    let mut next_id = 1_u64;
    let mut pending: HashMap<u64, String> = HashMap::new();
    loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else {
                    return Err("Bezi ACP command channel closed".to_owned());
                };
                match command {
                    AcpCommand::Request { request_id, method, params } => {
                        let id = next_id;
                        next_id = next_id.checked_add(1)
                            .ok_or_else(|| "Bezi ACP request sequence exhausted".to_owned())?;
                        pending.insert(id, request_id);
                        sink.send(Message::Text(
                            json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "method": method,
                                "params": params,
                            })
                            .to_string()
                            .into(),
                        ))
                        .await
                        .map_err(|error| format!("Could not send Bezi ACP request: {error}"))?;
                    }
                    AcpCommand::Response { acp_id, result } => {
                        sink.send(Message::Text(
                            json!({ "jsonrpc": "2.0", "id": acp_id, "result": result })
                                .to_string()
                                .into(),
                        ))
                        .await
                        .map_err(|error| format!("Could not answer Bezi ACP request: {error}"))?;
                    }
                }
            }
            incoming = stream.next() => {
                let incoming = incoming
                    .ok_or_else(|| "Bezi ACP closed the connection".to_owned())?
                    .map_err(|error| format!("Bezi ACP socket failed: {error}"))?;
                if matches!(incoming, Message::Ping(_)) {
                    if let Message::Ping(value) = incoming {
                        sink.send(Message::Pong(value)).await
                            .map_err(|error| format!("Could not answer Bezi ACP ping: {error}"))?;
                    }
                    continue;
                }
                let value = parse_text(incoming)?;
                let request_id = value
                    .get("id")
                    .and_then(Value::as_u64)
                    .and_then(|id| pending.remove(&id));
                let _ = events.send(AcpEvent { request_id, value });
            }
        }
    }
}

fn parse_text(message: Message) -> Result<Value, String> {
    let text = message
        .into_text()
        .map_err(|_| "Bezi ACP sent a non-text message".to_owned())?;
    if text.len() > 6_000_000 {
        return Err("Bezi ACP message exceeded the six MiB limit".to_owned());
    }
    serde_json::from_str(&text).map_err(|_| "Bezi ACP sent invalid JSON".to_owned())
}

fn is_allowed_method(method: &str) -> bool {
    matches!(
        method,
        "session/new"
            | "session/load"
            | "session/resume"
            | "session/close"
            | "session/delete"
            | "session/list"
            | "session/prompt"
            | "session/cancel"
            | "session/set_mode"
            | "session/set_model"
            | "session/set_config_option"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acp_allowlist_excludes_filesystem_and_terminal_methods() {
        assert!(is_allowed_method("session/prompt"));
        assert!(!is_allowed_method("fs/read_text_file"));
        assert!(!is_allowed_method("terminal/create"));
    }
}
