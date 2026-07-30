use std::{collections::HashMap, io, sync::Arc};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::{NamedPipeServer, ServerOptions},
    sync::{broadcast, mpsc, RwLock},
};

pub const PIPE_NAME: &str = r"\\.\pipe\bezi-remote-unity-v1";
const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnityInstance {
    pub instance_id: String,
    pub process_id: u32,
    pub project_name: String,
    pub project_path: String,
    pub unity_version: String,
    pub open_scenes: Vec<String>,
    pub playing: bool,
    pub paused: bool,
    pub compiling: bool,
    pub last_seen_at: String,
}

#[derive(Debug, Clone)]
pub struct UnityResult {
    pub instance_id: String,
    pub request_id: String,
    pub success: bool,
    pub body_json: Option<String>,
    pub error_code: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum UnityMessage {
    Register {
        #[serde(flatten)]
        instance: RegisterMessage,
    },
    Status {
        #[serde(rename = "instanceId")]
        instance_id: String,
        #[serde(rename = "openScenes")]
        open_scenes: Vec<String>,
        playing: bool,
        paused: bool,
        compiling: bool,
    },
    Pong {
        #[serde(rename = "instanceId")]
        instance_id: String,
    },
    Result {
        #[serde(rename = "instanceId")]
        instance_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        success: bool,
        #[serde(rename = "bodyJson")]
        body_json: Option<String>,
        #[serde(rename = "errorCode")]
        error_code: Option<String>,
        message: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterMessage {
    protocol_version: u32,
    instance_id: String,
    process_id: u32,
    project_name: String,
    project_path: String,
    unity_version: String,
    open_scenes: Vec<String>,
    playing: bool,
    paused: bool,
    compiling: bool,
}

#[derive(Clone)]
pub struct UnityRegistry {
    instances: Arc<RwLock<HashMap<String, UnityInstance>>>,
    commands: Arc<RwLock<HashMap<String, mpsc::Sender<serde_json::Value>>>>,
    results: broadcast::Sender<UnityResult>,
}

impl Default for UnityRegistry {
    fn default() -> Self {
        let (results, _) = broadcast::channel(256);
        Self {
            instances: Arc::new(RwLock::new(HashMap::new())),
            commands: Arc::new(RwLock::new(HashMap::new())),
            results,
        }
    }
}

impl UnityRegistry {
    pub fn count(&self) -> usize {
        self.instances
            .try_read()
            .map(|instances| instances.len())
            .unwrap_or_default()
    }

    pub async fn snapshot(&self) -> Vec<UnityInstance> {
        let mut values: Vec<_> = self.instances.read().await.values().cloned().collect();
        values.sort_by(|left, right| left.project_name.cmp(&right.project_name));
        values
    }

    pub async fn process_id_for(&self, instance_id: &str) -> Result<u32, String> {
        let instances = self.instances.read().await;
        if instance_id == "active" {
            let mut values: Vec<_> = instances.values().collect();
            values.sort_by(|left, right| left.project_name.cmp(&right.project_name));
            return values
                .first()
                .map(|instance| instance.process_id)
                .ok_or_else(|| "No Unity Editor package is connected".to_owned());
        }
        instances
            .get(instance_id)
            .map(|instance| instance.process_id)
            .ok_or_else(|| "The selected Unity Editor is no longer connected".to_owned())
    }

    pub fn subscribe_results(&self) -> broadcast::Receiver<UnityResult> {
        self.results.subscribe()
    }

    pub async fn send_command(
        &self,
        instance_id: &str,
        request_id: &str,
        action: &str,
        body: &serde_json::Value,
    ) -> Result<String, String> {
        let commands = self.commands.read().await;
        let resolved_id = if instance_id == "active" {
            let mut ids: Vec<_> = commands.keys().cloned().collect();
            ids.sort();
            ids.into_iter()
                .next()
                .ok_or_else(|| "No Unity Editor package is connected".to_owned())?
        } else {
            instance_id.to_owned()
        };
        let sender = commands
            .get(&resolved_id)
            .ok_or_else(|| "The selected Unity Editor is no longer connected".to_owned())?;
        sender
            .send(serde_json::json!({
                "type": "command",
                "protocolVersion": 1,
                "instanceId": resolved_id,
                "requestId": request_id,
                "action": action,
                "bodyJson": serde_json::to_string(body)
                    .map_err(|error| format!("Could not serialize Unity command: {error}"))?,
            }))
            .await
            .map_err(|_| "The Unity Editor command channel closed".to_owned())?;
        Ok(resolved_id)
    }

    async fn remove(&self, instance_id: &str) {
        self.instances.write().await.remove(instance_id);
        self.commands.write().await.remove(instance_id);
    }

    async fn apply(
        &self,
        message: UnityMessage,
        command_sender: &mpsc::Sender<serde_json::Value>,
    ) -> Result<String, String> {
        match message {
            UnityMessage::Register { instance } => {
                if instance.protocol_version != 1 {
                    return Err("Unity package protocol version is unsupported".to_owned());
                }
                let id = instance.instance_id.clone();
                self.instances.write().await.insert(
                    id.clone(),
                    UnityInstance {
                        instance_id: id.clone(),
                        process_id: instance.process_id,
                        project_name: instance.project_name,
                        project_path: instance.project_path,
                        unity_version: instance.unity_version,
                        open_scenes: instance.open_scenes,
                        playing: instance.playing,
                        paused: instance.paused,
                        compiling: instance.compiling,
                        last_seen_at: Utc::now().to_rfc3339(),
                    },
                );
                self.commands
                    .write()
                    .await
                    .insert(id.clone(), command_sender.clone());
                Ok(id)
            }
            UnityMessage::Status {
                instance_id,
                open_scenes,
                playing,
                paused,
                compiling,
            } => {
                let mut instances = self.instances.write().await;
                let instance = instances.get_mut(&instance_id).ok_or_else(|| {
                    "Unity instance must register before status updates".to_owned()
                })?;
                instance.open_scenes = open_scenes;
                instance.playing = playing;
                instance.paused = paused;
                instance.compiling = compiling;
                instance.last_seen_at = Utc::now().to_rfc3339();
                Ok(instance_id)
            }
            UnityMessage::Pong { instance_id } => {
                if let Some(instance) = self.instances.write().await.get_mut(&instance_id) {
                    instance.last_seen_at = Utc::now().to_rfc3339();
                }
                Ok(instance_id)
            }
            UnityMessage::Result {
                instance_id,
                request_id,
                success,
                body_json,
                error_code,
                message,
            } => {
                let _ = self.results.send(UnityResult {
                    instance_id: instance_id.clone(),
                    request_id,
                    success,
                    body_json,
                    error_code,
                    message,
                });
                Ok(instance_id)
            }
        }
    }
}

pub async fn run_pipe_server(registry: UnityRegistry) -> Result<(), String> {
    let mut first = true;
    loop {
        let mut options = ServerOptions::new();
        options
            .first_pipe_instance(first)
            .access_inbound(true)
            .access_outbound(true)
            .reject_remote_clients(true);
        let server = options
            .create(PIPE_NAME)
            .map_err(|error| format!("Could not create Unity named pipe: {error}"))?;
        first = false;
        server
            .connect()
            .await
            .map_err(|error| format!("Could not accept Unity named-pipe connection: {error}"))?;
        let client_registry = registry.clone();
        tokio::spawn(async move {
            let _ = handle_client(server, client_registry).await;
        });
    }
}

async fn handle_client(mut pipe: NamedPipeServer, registry: UnityRegistry) -> Result<(), String> {
    let mut registered_id: Option<String> = None;
    let (command_sender, mut command_receiver) = mpsc::channel(64);
    loop {
        tokio::select! {
            message = read_message(&mut pipe) => {
                let Some(message) = message? else { break };
                let instance_id = registry.apply(message, &command_sender).await?;
                registered_id = Some(instance_id);
                write_json(
                    &mut pipe,
                    &serde_json::json!({ "type": "ack", "protocolVersion": 1 }),
                )
                .await?;
            }
            command = command_receiver.recv(), if registered_id.is_some() => {
                let Some(command) = command else { break };
                write_json(&mut pipe, &command).await?;
            }
        }
    }
    if let Some(instance_id) = registered_id {
        registry.remove(&instance_id).await;
    }
    Ok(())
}

async fn read_message(pipe: &mut NamedPipeServer) -> Result<Option<UnityMessage>, String> {
    let length = match pipe.read_u32_le().await {
        Ok(length) => length as usize,
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(format!("Unity pipe read failed: {error}")),
    };
    if length == 0 || length > MAX_MESSAGE_BYTES {
        return Err("Unity message exceeded the four MiB limit".to_owned());
    }
    let mut payload = vec![0_u8; length];
    pipe.read_exact(&mut payload)
        .await
        .map_err(|error| format!("Unity pipe payload failed: {error}"))?;
    serde_json::from_slice(&payload)
        .map(Some)
        .map_err(|error| format!("Unity sent invalid protocol JSON: {error}"))
}

async fn write_json(pipe: &mut NamedPipeServer, value: &serde_json::Value) -> Result<(), String> {
    let payload = serde_json::to_vec(value)
        .map_err(|error| format!("Could not serialize Unity response: {error}"))?;
    pipe.write_u32_le(payload.len() as u32)
        .await
        .map_err(|error| format!("Could not write Unity response length: {error}"))?;
    pipe.write_all(&payload)
        .await
        .map_err(|error| format!("Could not write Unity response: {error}"))?;
    Ok(())
}
