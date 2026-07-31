use std::{
    collections::{HashMap, HashSet},
    fs,
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime},
};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::{header::SEC_WEBSOCKET_PROTOCOL, HeaderValue},
        Message,
    },
};

#[derive(Debug, Clone, Deserialize)]
pub struct AcpDescriptor {
    pub port: u16,
    pub pid: u32,
    pub token: String,
    pub version: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeziStatus {
    pub installed: bool,
    pub connected: bool,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSnapshot {
    pub protocol_version: u32,
    pub agent_name: String,
    pub session_list_supported: bool,
}

static CACHED_PROJECT_WORKSPACES: OnceLock<Mutex<(Option<Instant>, HashMap<String, String>)>> =
    OnceLock::new();
static CACHED_WORKSPACE_CATALOG: OnceLock<Mutex<CachedWorkspaceCatalogCache>> = OnceLock::new();
static VERIFIED_WORKSPACE_PAGES: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();

#[derive(Clone, Default)]
struct CachedWorkspaceCatalog {
    names: HashMap<String, String>,
    pages: HashMap<String, Value>,
}

#[derive(Default)]
struct CachedWorkspaceCatalogCache {
    checked_at: Option<Instant>,
    files: HashMap<PathBuf, CachedWorkspaceFile>,
    catalog: CachedWorkspaceCatalog,
}

struct CachedWorkspaceFile {
    modified_at: Option<SystemTime>,
    length: u64,
    page_workspaces: HashMap<String, String>,
    names: HashMap<String, String>,
    node_sets: Vec<Vec<Value>>,
}

pub fn status() -> BeziStatus {
    let descriptor = read_descriptor().ok();
    let connected = descriptor.as_ref().is_some_and(|value| {
        let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), value.port);
        TcpStream::connect_timeout(&address, Duration::from_millis(180)).is_ok()
    });
    BeziStatus {
        installed: descriptor.is_some(),
        connected,
        version: descriptor.and_then(|value| match value.version {
            Value::String(version) => Some(version),
            Value::Number(version) => Some(version.to_string()),
            _ => None,
        }),
    }
}

pub fn workspace_snapshot() -> Value {
    workspace_snapshot_inner(false, false)
}

pub fn workspace_snapshot_with_ui(complete_pages: bool) -> Value {
    workspace_snapshot_inner(true, complete_pages)
}

fn workspace_snapshot_inner(include_ui: bool, complete_pages: bool) -> Value {
    let Some(root) = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|path| path.join("com.bezi.app"))
    else {
        return json!({
            "projects": [],
            "workspaces": [],
            "sessions": [],
            "skills": [],
            "activeWorkspaceId": Value::Null,
            "activeProjectId": Value::Null,
            "ui": {}
        });
    };

    let projects = fs::read_to_string(root.join("projects.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.get("projects").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    let sanitized_projects = projects
        .iter()
        .filter_map(|project| {
            Some(json!({
                "id": project.get("id")?.as_str()?,
                "label": project.get("label")?.as_str()?,
                "path": project.get("path")?.as_str()?,
                "type": project.get("type").and_then(Value::as_str).unwrap_or("None"),
                "lastModified": project.get("lastModified").cloned().unwrap_or(Value::Null),
            }))
        })
        .take(100)
        .collect::<Vec<_>>();
    let project_by_id = projects
        .iter()
        .filter_map(|project| {
            Some((
                project.get("id")?.as_str()?.to_owned(),
                (
                    project.get("label")?.as_str()?.to_owned(),
                    project.get("path")?.as_str()?.to_owned(),
                ),
            ))
        })
        .collect::<HashMap<_, _>>();
    let project_ids = project_by_id.keys().cloned().collect::<HashSet<_>>();
    let cached_project_workspaces = read_cached_project_workspaces(&project_ids);
    let mut cached_workspace_catalog = read_cached_workspace_catalog();
    let ui = if include_ui {
        crate::bezi_ui::snapshot(&project_ids, &root.join("canvases"), complete_pages)
    } else {
        json!({
            "pages": [],
            "canvases": [],
            "visibleProjectIds": [],
            "navigation": [],
            "activeThreadTitle": Value::Null,
        })
    };
    let active_thread_title = ui
        .get("activeThreadTitle")
        .and_then(Value::as_str)
        .map(str::to_owned);

    let session_values = fs::read_to_string(root.join("acp-sessions.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.get("sessions").and_then(Value::as_object).cloned())
        .unwrap_or_default()
        .into_values()
        .collect::<Vec<_>>();
    let mut sessions = session_values
        .iter()
        .filter_map(|session| {
            let session_id = session.get("sessionId")?.as_str()?;
            let project_id = session.get("projectUUID")?.as_str()?;
            let (project_label, cwd) = project_by_id.get(project_id)?;
            let updated_at = session
                .get("updatedAt")
                .and_then(Value::as_str)
                .unwrap_or_default();
            Some(json!({
                "sessionId": session_id,
                "threadId": session.get("threadUUID").and_then(Value::as_str),
                "projectId": project_id,
                "projectLabel": project_label,
                "workspaceId": session.get("workspaceUUID").and_then(Value::as_str),
                "cwd": cwd,
                "updatedAt": updated_at,
            }))
        })
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| {
        right
            .get("updatedAt")
            .and_then(Value::as_str)
            .cmp(&left.get("updatedAt").and_then(Value::as_str))
    });
    sessions.truncate(250);
    for (index, session) in sessions.iter_mut().enumerate() {
        let title = if index == 0 {
            active_thread_title.clone()
        } else {
            None
        }
        .unwrap_or_else(|| {
            let updated_at = session
                .get("updatedAt")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if updated_at.len() >= 16 {
                format!("Thread · {}", updated_at[..16].replace('T', " "))
            } else {
                "Bezi thread".to_owned()
            }
        });
        session
            .as_object_mut()
            .expect("session snapshot is an object")
            .insert("title".to_owned(), Value::String(title));
    }
    let workspace_document = fs::read_to_string(root.join("workspaces.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({}));
    let active_workspace_id =
        resolve_current_workspace_id(read_active_workspace_id(), &workspace_document).or_else(
            || {
                sessions
                    .first()
                    .and_then(|session| session.get("workspaceId"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            },
        );
    retain_verified_workspace_pages(
        &mut cached_workspace_catalog,
        active_workspace_id.as_deref(),
        &ui,
    );
    let active_project_by_workspace = workspace_document
        .get("active_project")
        .and_then(Value::as_object);
    let active_project_id = active_workspace_id
        .as_ref()
        .and_then(|workspace_id| active_project_by_workspace?.get(workspace_id))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            sessions
                .first()
                .and_then(|session| session.get("projectId"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let workspaces = build_workspace_catalog(
        &workspace_document,
        &session_values,
        &sanitized_projects,
        &project_by_id,
        &cached_project_workspaces,
        &cached_workspace_catalog,
        &ui,
        active_workspace_id.as_deref(),
    );

    let mut skills = fs::read_dir(root.join("skills"))
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().join("SKILL.md").is_file())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect::<Vec<_>>();
    skills.sort_by_key(|value| value.to_lowercase());
    skills.truncate(200);

    json!({
        "projects": sanitized_projects,
        "workspaces": workspaces,
        "sessions": sessions,
        "skills": skills,
        "activeWorkspaceId": active_workspace_id,
        "activeProjectId": active_project_id,
        "ui": ui,
    })
}

fn build_workspace_catalog(
    workspace_document: &Value,
    sessions: &[Value],
    sanitized_projects: &[Value],
    project_by_id: &HashMap<String, (String, String)>,
    cached_project_workspaces: &HashMap<String, String>,
    cached_workspace_catalog: &CachedWorkspaceCatalog,
    ui: &Value,
    active_workspace_id: Option<&str>,
) -> Vec<Value> {
    let sanitized_by_id = sanitized_projects
        .iter()
        .filter_map(|project| Some((project.get("id")?.as_str()?.to_owned(), project.clone())))
        .collect::<HashMap<_, _>>();
    let mut project_ids_by_workspace = HashMap::<String, Vec<String>>::new();
    let mut add_project = |workspace_id: &str, project_id: &str| {
        if !looks_like_uuid_value(workspace_id) || !sanitized_by_id.contains_key(project_id) {
            return;
        }
        let projects = project_ids_by_workspace
            .entry(workspace_id.to_owned())
            .or_default();
        if !projects.iter().any(|value| value == project_id) {
            projects.push(project_id.to_owned());
        }
    };

    let mut session_project_by_workspace = HashMap::<String, String>::new();
    for session in sessions {
        if let (Some(workspace_id), Some(project_id)) = (
            session.get("workspaceUUID").and_then(Value::as_str),
            session.get("projectUUID").and_then(Value::as_str),
        ) {
            add_project(workspace_id, project_id);
            session_project_by_workspace
                .entry(workspace_id.to_owned())
                .or_insert_with(|| project_id.to_owned());
        }
    }
    for (project_id, workspace_id) in cached_project_workspaces {
        add_project(workspace_id, project_id);
    }
    if let Some(disabled) = workspace_document
        .get("disabled_projects")
        .and_then(Value::as_object)
    {
        for (workspace_id, projects) in disabled {
            for project_id in projects.as_array().into_iter().flatten() {
                if let Some(project_id) = project_id.as_str() {
                    add_project(workspace_id, project_id);
                }
            }
        }
    }
    if let Some(active_projects) = workspace_document
        .get("active_project")
        .and_then(Value::as_object)
    {
        for (workspace_id, project_id) in active_projects {
            if let Some(project_id) = project_id.as_str() {
                add_project(workspace_id, project_id);
            }
        }
    }
    if let Some(local_workspaces) = workspace_document
        .get("workspaces")
        .and_then(Value::as_array)
    {
        for workspace in local_workspaces {
            let Some(workspace_id) = workspace.get("id").and_then(Value::as_str) else {
                continue;
            };
            for project in workspace
                .get("projects")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let project_id = project
                    .as_str()
                    .or_else(|| project.get("id").and_then(Value::as_str));
                if let Some(project_id) = project_id {
                    add_project(workspace_id, project_id);
                }
            }
        }
    }

    let visible_project_ids = ui
        .get("visibleProjectIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|project_id| sanitized_by_id.contains_key(*project_id))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if let Some(active_workspace_id) = active_workspace_id {
        for project_id in &visible_project_ids {
            add_project(active_workspace_id, project_id);
        }
    }
    drop(add_project);
    if let Some(active_workspace_id) = active_workspace_id {
        project_ids_by_workspace
            .entry(active_workspace_id.to_owned())
            .or_default();
    }

    let active_projects = workspace_document
        .get("active_project")
        .and_then(Value::as_object);
    let local_workspace_names = workspace_document
        .get("workspaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|workspace| {
            Some((
                workspace.get("id")?.as_str()?.to_owned(),
                workspace.get("name")?.as_str()?.to_owned(),
            ))
        })
        .collect::<HashMap<_, _>>();

    let mut workspace_ids = project_ids_by_workspace.keys().cloned().collect::<Vec<_>>();
    workspace_ids.sort_by(|left, right| {
        let left_active = Some(left.as_str()) == active_workspace_id;
        let right_active = Some(right.as_str()) == active_workspace_id;
        right_active.cmp(&left_active).then_with(|| left.cmp(right))
    });

    workspace_ids
        .into_iter()
        .map(|workspace_id| {
            let is_active = Some(workspace_id.as_str()) == active_workspace_id;
            let active_project_id = active_projects
                .and_then(|projects| projects.get(&workspace_id))
                .and_then(Value::as_str);
            let mut project_ids = project_ids_by_workspace
                .remove(&workspace_id)
                .unwrap_or_default();
            if is_active && !visible_project_ids.is_empty() {
                project_ids.sort_by_key(|project_id| {
                    visible_project_ids
                        .iter()
                        .position(|visible_id| visible_id == project_id)
                        .unwrap_or(usize::MAX)
                });
            }
            let projects = project_ids
                .iter()
                .filter_map(|project_id| sanitized_by_id.get(project_id).cloned())
                .collect::<Vec<_>>();
            let active_workspace_label = if is_active {
                visible_project_ids
                    .first()
                    .and_then(|project_id| project_by_id.get(project_id))
                    .map(|project| project.0.clone())
            } else {
                None
            };
            let label = local_workspace_names
                .get(&workspace_id)
                .cloned()
                .or_else(|| cached_workspace_catalog.names.get(&workspace_id).cloned())
                .or(active_workspace_label)
                .or_else(|| {
                    session_project_by_workspace
                        .get(&workspace_id)
                        .and_then(|project_id| project_by_id.get(project_id))
                        .map(|project| project.0.clone())
                })
                .or_else(|| {
                    active_project_id
                        .and_then(|project_id| project_by_id.get(project_id))
                        .map(|project| format!("{} workspace", project.0))
                })
                .or_else(|| {
                    project_ids
                        .iter()
                        .filter_map(|project_id| project_by_id.get(project_id))
                        .map(|project| project.0.as_str())
                        .min_by_key(|label| label.to_lowercase())
                        .map(str::to_owned)
                })
                .unwrap_or_else(|| format!("Workspace {}", &workspace_id[..8]));
            let workspace_ui = if is_active {
                merge_active_workspace_ui(
                    ui,
                    verified_workspace_ui(cached_workspace_catalog.pages.get(&workspace_id)),
                )
            } else {
                cached_workspace_catalog
                    .pages
                    .get(&workspace_id)
                    .cloned()
                    .unwrap_or_else(empty_workspace_ui)
            };
            json!({
                "id": workspace_id,
                "label": label,
                "projects": projects,
                "activeProjectId": active_project_id,
                "isActive": is_active,
                "ui": workspace_ui,
            })
        })
        .collect()
}

fn verified_workspace_ui(cached_ui: Option<&Value>) -> Option<&Value> {
    cached_ui.filter(|value| value.get("verified").and_then(Value::as_bool) == Some(true))
}

fn merge_active_workspace_ui(live_ui: &Value, cached_ui: Option<&Value>) -> Value {
    let Some(cached_pages) = cached_ui
        .and_then(|value| value.get("pages"))
        .and_then(Value::as_array)
        .filter(|pages| !pages.is_empty())
    else {
        return live_ui.clone();
    };
    if live_ui.get("available").and_then(Value::as_bool) != Some(true) {
        let mut merged = live_ui.clone();
        if let Some(object) = merged.as_object_mut() {
            object.insert("pages".to_owned(), Value::Array(cached_pages.clone()));
            object.insert("cached".to_owned(), Value::Bool(true));
        }
        return merged;
    }
    let live_pages = live_ui
        .get("pages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if live_ui.get("pagesComplete").and_then(Value::as_bool) == Some(true) {
        let pages = live_pages
            .into_iter()
            .map(|mut item| {
                if let Some(object) = item.as_object_mut() {
                    object.insert("remote".to_owned(), Value::Bool(true));
                }
                item
            })
            .collect::<Vec<_>>();
        let mut merged = live_ui.clone();
        if let Some(object) = merged.as_object_mut() {
            object.insert("pages".to_owned(), Value::Array(pages));
            object.insert("cached".to_owned(), Value::Bool(false));
        }
        return merged;
    }
    let live_by_id = live_pages
        .iter()
        .filter_map(|item| Some((item.get("id")?.as_str()?.to_owned(), item)))
        .collect::<HashMap<_, _>>();
    let mut merged_ids = HashSet::new();
    let mut merged_pages = Vec::with_capacity(cached_pages.len() + live_pages.len());

    // The cache is a complete node response, while the accessibility tree is only
    // the currently materialized sidebar viewport. Preserve cache order/hierarchy
    // and use live UI solely to overlay visible state such as title/expansion.
    for cached_item in cached_pages {
        let Some(id) = cached_item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let mut item = cached_item.clone();
        if let (Some(object), Some(live_object)) = (
            item.as_object_mut(),
            live_by_id.get(id).and_then(|value| value.as_object()),
        ) {
            for (key, value) in live_object {
                object.insert(key.clone(), value.clone());
            }
        }
        if let Some(object) = item.as_object_mut() {
            object.insert("remote".to_owned(), Value::Bool(true));
        }
        merged_ids.insert(id.to_owned());
        merged_pages.push(item);
    }

    // A just-created page can reach the rendered UI before the WebView cache is
    // flushed. Include it immediately without allowing viewport absence to delete
    // anything from the complete catalog.
    let mut previous_live_id: Option<String> = None;
    for (live_index, live_item) in live_pages.iter().enumerate() {
        let Some(id) = live_item.get("id").and_then(Value::as_str) else {
            continue;
        };
        if merged_ids.contains(id) {
            previous_live_id = Some(id.to_owned());
            continue;
        }
        let insertion_index = previous_live_id
            .as_deref()
            .and_then(|previous_id| {
                let previous_index = merged_pages
                    .iter()
                    .position(|item| item.get("id").and_then(Value::as_str) == Some(previous_id))?;
                let previous_depth = merged_pages[previous_index]
                    .get("depth")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                Some(
                    merged_pages
                        .iter()
                        .enumerate()
                        .skip(previous_index + 1)
                        .find(|(_, item)| {
                            item.get("depth").and_then(Value::as_u64).unwrap_or(0) <= previous_depth
                        })
                        .map(|(index, _)| index)
                        .unwrap_or(merged_pages.len()),
                )
            })
            .or_else(|| {
                live_pages.iter().skip(live_index + 1).find_map(|next| {
                    let next_id = next.get("id").and_then(Value::as_str)?;
                    merged_pages
                        .iter()
                        .position(|item| item.get("id").and_then(Value::as_str) == Some(next_id))
                })
            })
            .unwrap_or(merged_pages.len());
        let mut item = live_item.clone();
        if let Some(object) = item.as_object_mut() {
            object.insert("remote".to_owned(), Value::Bool(true));
        }
        merged_pages.insert(insertion_index, item);
        merged_ids.insert(id.to_owned());
        previous_live_id = Some(id.to_owned());
    }

    let mut merged = live_ui.clone();
    if let Some(object) = merged.as_object_mut() {
        object.insert("pages".to_owned(), Value::Array(merged_pages));
        object.insert("cached".to_owned(), Value::Bool(true));
    }
    merged
}

fn empty_workspace_ui() -> Value {
    json!({
        "pages": [],
        "canvases": [],
        "visibleProjectIds": [],
        "navigation": [],
        "activeThreadTitle": Value::Null,
    })
}

fn latest_local_workspace_id(workspace_document: &Value) -> Option<String> {
    workspace_document
        .get("workspaces")
        .and_then(Value::as_array)?
        .iter()
        .enumerate()
        .filter_map(|(index, workspace)| {
            let id = workspace.get("id")?.as_str()?;
            looks_like_uuid_value(id).then_some((
                workspace
                    .get("updatedAt")
                    .and_then(Value::as_i64)
                    .unwrap_or(i64::MIN),
                index,
                id.to_owned(),
            ))
        })
        .max_by_key(|(updated_at, index, _)| (*updated_at, *index))
        .map(|(_, _, id)| id)
}

fn resolve_current_workspace_id(
    webview_workspace_id: Option<String>,
    workspace_document: &Value,
) -> Option<String> {
    webview_workspace_id.or_else(|| latest_local_workspace_id(workspace_document))
}

pub(crate) fn current_workspace_id() -> Option<String> {
    let workspace_document = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .and_then(|root| fs::read_to_string(root.join("com.bezi.app").join("workspaces.json")).ok())
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({}));
    resolve_current_workspace_id(read_active_workspace_id(), &workspace_document)
}

fn read_cached_workspace_catalog() -> CachedWorkspaceCatalog {
    let cache =
        CACHED_WORKSPACE_CATALOG.get_or_init(|| Mutex::new(CachedWorkspaceCatalogCache::default()));
    let Ok(mut cached) = cache.lock() else {
        return CachedWorkspaceCatalog::default();
    };
    if cached
        .checked_at
        .is_some_and(|updated_at| updated_at.elapsed() < Duration::from_secs(1))
    {
        return cached.catalog.clone();
    }
    cached.checked_at = Some(Instant::now());

    let cache_root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|path| {
            path.join("com.bezi.app")
                .join("EBWebView")
                .join("Default")
                .join("Cache")
                .join("Cache_Data")
        });
    let Some(cache_root) = cache_root else {
        return cached.catalog.clone();
    };

    let entries = fs::read_dir(cache_root)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("data_"))
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            Some((entry.path(), metadata.modified().ok(), metadata.len()))
        })
        .collect::<Vec<_>>();
    let current_paths = entries
        .iter()
        .map(|(path, _, _)| path.clone())
        .collect::<HashSet<_>>();
    let mut changed = cached
        .files
        .keys()
        .any(|path| !current_paths.contains(path));
    cached.files.retain(|path, _| current_paths.contains(path));

    for (path, modified_at, length) in entries {
        let unchanged = cached
            .files
            .get(&path)
            .is_some_and(|file| file.modified_at == modified_at && file.length == length);
        if unchanged {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        let mut page_workspaces = HashMap::new();
        let mut names = HashMap::new();
        let mut node_sets = Vec::new();
        collect_cached_workspace_file(&bytes, &mut page_workspaces, &mut names, &mut node_sets);
        cached.files.insert(
            path,
            CachedWorkspaceFile {
                modified_at,
                length,
                page_workspaces,
                names,
                node_sets,
            },
        );
        changed = true;
    }

    if changed {
        let mut sources = cached.files.iter().collect::<Vec<_>>();
        sources.sort_by(|(left_path, left), (right_path, right)| {
            left.modified_at
                .cmp(&right.modified_at)
                .then_with(|| left.length.cmp(&right.length))
                .then_with(|| left_path.cmp(right_path))
        });
        let mut page_workspaces = HashMap::new();
        let mut names = HashMap::new();
        let mut node_sets = Vec::new();
        for (_, source) in sources {
            page_workspaces.extend(source.page_workspaces.clone());
            names.extend(source.names.clone());
            node_sets.extend(source.node_sets.clone());
        }
        cached.catalog = finish_cached_workspace_catalog(page_workspaces, names, node_sets);
    }
    cached.catalog.clone()
}

fn retain_verified_workspace_pages(
    catalog: &mut CachedWorkspaceCatalog,
    active_workspace_id: Option<&str>,
    live_ui: &Value,
) {
    let verified = VERIFIED_WORKSPACE_PAGES.get_or_init(|| Mutex::new(HashMap::new()));
    let Ok(mut verified) = verified.lock() else {
        return;
    };
    if live_ui.get("pagesComplete").and_then(Value::as_bool) == Some(true) {
        if let Some(workspace_id) = active_workspace_id {
            let mut verified_ui = live_ui.clone();
            if let Some(object) = verified_ui.as_object_mut() {
                object.insert("verified".to_owned(), Value::Bool(true));
            }
            verified.insert(workspace_id.to_owned(), verified_ui);
        }
    }
    apply_verified_workspace_pages(catalog, &verified);
}

fn apply_verified_workspace_pages(
    catalog: &mut CachedWorkspaceCatalog,
    verified: &HashMap<String, Value>,
) {
    for (workspace_id, pages) in verified {
        catalog.pages.insert(workspace_id.clone(), pages.clone());
    }
}

#[cfg(test)]
fn collect_cached_workspace_catalog(cache_files: &[Vec<u8>]) -> CachedWorkspaceCatalog {
    let mut page_workspaces = HashMap::<String, String>::new();
    let mut names = HashMap::<String, String>::new();
    let mut node_sets = Vec::<Vec<Value>>::new();
    for bytes in cache_files {
        collect_cached_workspace_file(bytes, &mut page_workspaces, &mut names, &mut node_sets);
    }
    finish_cached_workspace_catalog(page_workspaces, names, node_sets)
}

fn collect_cached_workspace_file(
    bytes: &[u8],
    page_workspaces: &mut HashMap<String, String>,
    names: &mut HashMap<String, String>,
    node_sets: &mut Vec<Vec<Value>>,
) {
    collect_page_workspace_links(bytes, page_workspaces);
    for response in cached_json_responses(bytes, b"{\"result\":{\"data\":{\"json\":[{") {
        let Some(nodes) = response
            .pointer("/result/data/json")
            .and_then(Value::as_array)
        else {
            continue;
        };

        for workspace in nodes {
            if let (Some(id), Some(name)) = (
                workspace.get("workspaceUUID").and_then(Value::as_str),
                workspace.get("name").and_then(Value::as_str),
            ) {
                if looks_like_uuid_value(id) && !name.trim().is_empty() {
                    names.insert(id.to_owned(), name.to_owned());
                }
            }
        }

        if node_sets.len() < 256
            && nodes
                .first()
                .is_some_and(|node| node.get("nodeUUID").is_some())
        {
            node_sets.push(nodes.iter().take(1000).cloned().collect());
        }
    }
}

fn finish_cached_workspace_catalog(
    page_workspaces: HashMap<String, String>,
    names: HashMap<String, String>,
    node_sets: Vec<Vec<Value>>,
) -> CachedWorkspaceCatalog {
    let mut pages = HashMap::<String, Value>::new();
    for nodes in node_sets {
        let workspace_id = nodes.iter().find_map(|node| {
            node.get("pageUUID")
                .and_then(Value::as_str)
                .and_then(|page_id| page_workspaces.get(page_id))
        });
        let Some(workspace_id) = workspace_id else {
            continue;
        };
        let items = flatten_cached_page_nodes(&nodes);
        pages.insert(
            workspace_id.clone(),
            json!({
                "pages": items,
                "canvases": [],
                "visibleProjectIds": [],
                "navigation": [],
                "activeThreadTitle": Value::Null,
                "cached": true,
            }),
        );
    }
    CachedWorkspaceCatalog { names, pages }
}

fn collect_page_workspace_links(bytes: &[u8], links: &mut HashMap<String, String>) {
    const WORKSPACE_MARKER: &[u8] = b"workspaceUUID%22%3A%22";
    const PAGE_MARKER: &[u8] = b"pageUUID%22%3A%22";
    let mut cursor = 0;
    while let Some(relative_position) = find_bytes(&bytes[cursor..], WORKSPACE_MARKER) {
        let marker_position = cursor + relative_position;
        let workspace_start = marker_position + WORKSPACE_MARKER.len();
        let workspace_end = workspace_start + 36;
        let search_end = (workspace_end + 220).min(bytes.len());
        let workspace_id = bytes
            .get(workspace_start..workspace_end)
            .and_then(|value| std::str::from_utf8(value).ok())
            .filter(|value| looks_like_uuid_value(value));
        if let (Some(workspace_id), Some(page_offset)) = (
            workspace_id,
            find_bytes(&bytes[workspace_end..search_end], PAGE_MARKER),
        ) {
            let page_start = workspace_end + page_offset + PAGE_MARKER.len();
            let page_end = page_start + 36;
            if let Some(page_id) = bytes
                .get(page_start..page_end)
                .and_then(|value| std::str::from_utf8(value).ok())
                .filter(|value| looks_like_uuid_value(value))
            {
                links.insert(page_id.to_owned(), workspace_id.to_owned());
            }
        }
        cursor = workspace_start;
    }
}

fn cached_json_responses(bytes: &[u8], marker: &[u8]) -> Vec<Value> {
    let mut responses = Vec::new();
    let mut cursor = 0;
    while let Some(relative_position) = find_bytes(&bytes[cursor..], marker) {
        let start = cursor + relative_position;
        let Some(end) = json_object_end(bytes, start) else {
            break;
        };
        if let Ok(response) = serde_json::from_slice(&bytes[start..end]) {
            responses.push(response);
        }
        cursor = end.max(start + marker.len());
    }
    responses
}

fn json_object_end(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.get(start) != Some(&b'{') {
        return None;
    }
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, byte) in bytes[start..].iter().copied().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(start + offset + 1);
                }
            }
            _ => {}
        }
    }
    None
}

fn flatten_cached_page_nodes(nodes: &[Value]) -> Vec<Value> {
    let page_nodes = nodes
        .iter()
        .filter(|node| node.get("tree").and_then(Value::as_str) == Some("pages"))
        .filter_map(|node| {
            Some((
                node.get("nodeUUID")?.as_str()?.to_owned(),
                node.get("title")?.as_str()?.to_owned(),
                node.get("parentUUID")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                node.get("fractionalIndex")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                node.get("itemType").and_then(Value::as_str) == Some("folder"),
            ))
        })
        .take(1000)
        .collect::<Vec<_>>();
    let known_ids = page_nodes
        .iter()
        .map(|node| node.0.as_str())
        .collect::<HashSet<_>>();
    let mut children = HashMap::<Option<String>, Vec<usize>>::new();
    for (index, node) in page_nodes.iter().enumerate() {
        let parent = node
            .2
            .as_ref()
            .filter(|parent| known_ids.contains(parent.as_str()))
            .cloned();
        children.entry(parent).or_default().push(index);
    }
    for siblings in children.values_mut() {
        siblings.sort_by(|left, right| page_nodes[*left].3.cmp(&page_nodes[*right].3));
    }

    fn append_nodes(
        parent: Option<String>,
        depth: usize,
        nodes: &[(String, String, Option<String>, String, bool)],
        children: &HashMap<Option<String>, Vec<usize>>,
        visited: &mut HashSet<String>,
        output: &mut Vec<Value>,
    ) {
        for index in children.get(&parent).into_iter().flatten() {
            let node = &nodes[*index];
            if !visited.insert(node.0.clone()) {
                continue;
            }
            output.push(json!({
                "id": node.0,
                "title": node.1,
                "kind": if node.4 { "folder" } else { "page" },
                "depth": depth,
                "expanded": false,
                "remote": false,
            }));
            append_nodes(
                Some(node.0.clone()),
                depth + 1,
                nodes,
                children,
                visited,
                output,
            );
        }
    }

    let mut output = Vec::new();
    let mut visited = HashSet::new();
    append_nodes(None, 0, &page_nodes, &children, &mut visited, &mut output);
    output
}

fn read_cached_project_workspaces(project_ids: &HashSet<String>) -> HashMap<String, String> {
    let cache = CACHED_PROJECT_WORKSPACES.get_or_init(|| Mutex::new((None, HashMap::new())));
    if let Ok(cached) = cache.lock() {
        if cached
            .0
            .is_some_and(|updated_at| updated_at.elapsed() < Duration::from_secs(30))
        {
            return cached.1.clone();
        }
    }

    let mut links = HashMap::new();
    if let Some(root) = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|path| {
            path.join("com.bezi.app")
                .join("EBWebView")
                .join("Default")
                .join("Cache")
                .join("Cache_Data")
        })
    {
        for entry in fs::read_dir(root).ok().into_iter().flatten().flatten() {
            let file_name = entry.file_name();
            if !file_name.to_string_lossy().starts_with("data_") {
                continue;
            }
            let Ok(bytes) = fs::read(entry.path()) else {
                continue;
            };
            collect_project_workspace_links(
                &bytes,
                b"projectUUID%22%3A%22",
                b"workspaceUUID%22%3A%22",
                project_ids,
                &mut links,
            );
            collect_project_workspace_links(
                &bytes,
                b"\"projectUUID\":\"",
                b"\"workspaceUUID\":\"",
                project_ids,
                &mut links,
            );
        }
    }

    if let Ok(mut cached) = cache.lock() {
        *cached = (Some(Instant::now()), links.clone());
    }
    links
}

fn collect_project_workspace_links(
    bytes: &[u8],
    project_marker: &[u8],
    workspace_marker: &[u8],
    project_ids: &HashSet<String>,
    links: &mut HashMap<String, String>,
) {
    let mut cursor = 0;
    while let Some(relative_position) = find_bytes(&bytes[cursor..], project_marker) {
        let marker_position = cursor + relative_position;
        let project_start = marker_position + project_marker.len();
        let project_end = project_start + 36;
        let Some(project_bytes) = bytes.get(project_start..project_end) else {
            break;
        };
        let project_id = std::str::from_utf8(project_bytes).ok();
        if let Some(project_id) = project_id.filter(|value| project_ids.contains(*value)) {
            let search_end = (project_end + 180).min(bytes.len());
            if let Some(workspace_offset) =
                find_bytes(&bytes[project_end..search_end], workspace_marker)
            {
                let workspace_start = project_end + workspace_offset + workspace_marker.len();
                let workspace_end = workspace_start + 36;
                if let Some(workspace_id) = bytes
                    .get(workspace_start..workspace_end)
                    .and_then(|value| std::str::from_utf8(value).ok())
                    .filter(|value| looks_like_uuid_value(value))
                {
                    links.insert(project_id.to_owned(), workspace_id.to_owned());
                }
            }
        }
        cursor = project_start;
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    memchr::memmem::find(haystack, needle)
}

pub(crate) fn read_active_workspace_id() -> Option<String> {
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)?
        .join("com.bezi.app")
        .join("EBWebView")
        .join("Default")
        .join("Local Storage")
        .join("leveldb");
    let mut files = fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| {
            matches!(
                entry.path().extension().and_then(|value| value.to_str()),
                Some("log" | "ldb")
            )
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|entry| {
        std::cmp::Reverse(
            entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok(),
        )
    });
    files.into_iter().find_map(|entry| {
        fs::read(entry.path())
            .ok()
            .and_then(|bytes| find_active_workspace_id(&bytes))
    })
}

fn find_active_workspace_id(bytes: &[u8]) -> Option<String> {
    const NEEDLE: &[u8] = b"\"active-workspace-id\":\"";
    bytes
        .windows(NEEDLE.len())
        .rposition(|window| window == NEEDLE)
        .and_then(|position| {
            let start = position + NEEDLE.len();
            let end = start + 36;
            let value = std::str::from_utf8(bytes.get(start..end)?).ok()?;
            looks_like_uuid_value(value).then(|| value.to_owned())
        })
}

fn looks_like_uuid_value(value: &str) -> bool {
    value.len() == 36
        && value
            .chars()
            .enumerate()
            .all(|(index, character)| match index {
                8 | 13 | 18 | 23 => character == '-',
                _ => character.is_ascii_hexdigit(),
            })
}

pub fn read_descriptor() -> Result<AcpDescriptor, String> {
    let path = descriptor_path()?;
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Bezi ACP descriptor is unavailable: {error}"))?;
    let descriptor: AcpDescriptor = serde_json::from_str(&raw)
        .map_err(|error| format!("Bezi ACP descriptor is invalid: {error}"))?;
    if descriptor.port == 0 || descriptor.pid == 0 || descriptor.token.trim().is_empty() {
        return Err("Bezi ACP descriptor failed validation".to_owned());
    }
    Ok(descriptor)
}

pub async fn probe_acp() -> Result<AcpSnapshot, String> {
    let descriptor = read_descriptor()?;
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

    let (mut socket, _) = connect_async(request)
        .await
        .map_err(|error| format!("Could not connect to Bezi ACP: {error}"))?;
    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "terminal": false
                    },
                    "clientInfo": {
                        "name": "Bezi Remote Companion",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }
            })
            .to_string()
            .into(),
        ))
        .await
        .map_err(|error| format!("Could not initialize Bezi ACP: {error}"))?;

    let response = tokio::time::timeout(Duration::from_secs(3), socket.next())
        .await
        .map_err(|_| "Bezi ACP initialization timed out".to_owned())?
        .ok_or_else(|| "Bezi ACP closed during initialization".to_owned())?
        .map_err(|error| format!("Bezi ACP initialization failed: {error}"))?;
    let text = response
        .into_text()
        .map_err(|_| "Bezi ACP returned a non-text initialization response".to_owned())?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("Bezi ACP returned invalid JSON: {error}"))?;
    let result = value
        .get("result")
        .ok_or_else(|| "Bezi ACP did not return an initialization result".to_owned())?;
    Ok(AcpSnapshot {
        protocol_version: result
            .get("protocolVersion")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(1) as u32,
        agent_name: result
            .pointer("/agentInfo/name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Bezi")
            .to_owned(),
        session_list_supported: result.pointer("/agentCapabilities/session/list").is_some()
            || result
                .pointer("/agentCapabilities/sessionCapabilities/list")
                .is_some(),
    })
}

fn descriptor_path() -> Result<PathBuf, String> {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|root| root.join("com.bezi.app").join("acp.json"))
        .ok_or_else(|| "Windows APPDATA is unavailable".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_latest_active_workspace_from_webview_state() {
        let bytes = br#"old "active-workspace-id":"11111111-1111-1111-1111-111111111111"
            new "active-workspace-id":"22222222-2222-2222-2222-222222222222""#;
        assert_eq!(
            find_active_workspace_id(bytes).as_deref(),
            Some("22222222-2222-2222-2222-222222222222")
        );
    }

    #[test]
    fn falls_back_to_the_most_recent_local_workspace() {
        let older = "11111111-1111-1111-1111-111111111111";
        let newer = "22222222-2222-2222-2222-222222222222";
        let workspace_document = json!({
            "workspaces": [
                { "id": older, "updatedAt": 10 },
                { "id": newer, "updatedAt": 20 }
            ]
        });

        assert_eq!(
            latest_local_workspace_id(&workspace_document).as_deref(),
            Some(newer)
        );
        assert_eq!(
            resolve_current_workspace_id(None, &workspace_document).as_deref(),
            Some(newer)
        );
        assert_eq!(
            resolve_current_workspace_id(Some(older.to_owned()), &workspace_document).as_deref(),
            Some(older)
        );
    }

    #[test]
    fn extracts_cached_project_workspace_relationships() {
        let project_id = "30bf90d4-2593-4d75-b414-b4e5a9a7d662";
        let workspace_id = "e076ae2d-13e4-4fef-8a2c-7eba3ccb7fa4";
        let bytes = format!(
            "projectUUID%22%3A%22{project_id}%22%2C%22workspaceUUID%22%3A%22{workspace_id}"
        );
        let project_ids = HashSet::from([project_id.to_owned()]);
        let mut links = HashMap::new();
        collect_project_workspace_links(
            bytes.as_bytes(),
            b"projectUUID%22%3A%22",
            b"workspaceUUID%22%3A%22",
            &project_ids,
            &mut links,
        );
        assert_eq!(
            links.get(project_id).map(String::as_str),
            Some(workspace_id)
        );
    }

    #[test]
    fn rebuilds_inactive_workspace_page_trees_from_webview_cache() {
        let workspace_id = "851a8a64-1f14-4a9a-bbe2-987d3e706dab";
        let folder_id = "11111111-1111-1111-1111-111111111111";
        let child_node_id = "22222222-2222-2222-2222-222222222222";
        let child_page_id = "33333333-3333-3333-3333-333333333333";
        let root_node_id = "44444444-4444-4444-4444-444444444444";
        let root_page_id = "55555555-5555-5555-5555-555555555555";
        let workspace_response = serde_json::to_vec(&json!({
            "result": {
                "data": {
                    "json": [{
                        "workspaceUUID": workspace_id,
                        "name": "Fresh Project"
                    }]
                }
            }
        }))
        .unwrap();
        let page_links = format!(
            "workspaceUUID%22%3A%22{workspace_id}%22%2C%22pageUUID%22%3A%22{child_page_id} \
             workspaceUUID%22%3A%22{workspace_id}%22%2C%22pageUUID%22%3A%22{root_page_id}"
        )
        .into_bytes();
        let node_response = serde_json::to_vec(&json!({
            "result": {
                "data": {
                    "json": [
                        {
                            "nodeUUID": child_node_id,
                            "title": "Child page",
                            "parentUUID": folder_id,
                            "fractionalIndex": "a0",
                            "itemType": "page",
                            "pageUUID": child_page_id,
                            "tree": "pages"
                        },
                        {
                            "nodeUUID": root_node_id,
                            "title": "Root page",
                            "parentUUID": Value::Null,
                            "fractionalIndex": "a1",
                            "itemType": "page",
                            "pageUUID": root_page_id,
                            "tree": "pages"
                        },
                        {
                            "nodeUUID": folder_id,
                            "title": "Folder",
                            "parentUUID": Value::Null,
                            "fractionalIndex": "a0",
                            "itemType": "folder",
                            "pageUUID": Value::Null,
                            "tree": "pages"
                        }
                    ]
                }
            }
        }))
        .unwrap();

        let catalog =
            collect_cached_workspace_catalog(&[workspace_response, page_links, node_response]);
        assert_eq!(
            catalog.names.get(workspace_id).map(String::as_str),
            Some("Fresh Project")
        );
        assert_eq!(
            catalog
                .pages
                .get(workspace_id)
                .and_then(|value| value.get("pages")),
            Some(&json!([
                {
                    "id": folder_id,
                    "title": "Folder",
                    "kind": "folder",
                    "depth": 0,
                    "expanded": false,
                    "remote": false
                },
                {
                    "id": child_node_id,
                    "title": "Child page",
                    "kind": "page",
                    "depth": 1,
                    "expanded": false,
                    "remote": false
                },
                {
                    "id": root_node_id,
                    "title": "Root page",
                    "kind": "page",
                    "depth": 0,
                    "expanded": false,
                    "remote": false
                }
            ]))
        );
    }

    #[test]
    fn overlays_visible_state_without_dropping_the_complete_cached_tree() {
        let cached = json!({
            "pages": [
                {
                    "id": "folder",
                    "title": "Design",
                    "kind": "folder",
                    "depth": 0,
                    "expanded": false,
                    "remote": false
                },
                {
                    "id": "cached-page",
                    "title": "New page",
                    "kind": "page",
                    "depth": 1,
                    "expanded": false,
                    "remote": false
                },
                {
                    "id": "other-folder",
                    "title": "Other",
                    "kind": "folder",
                    "depth": 0,
                    "expanded": false,
                    "remote": false
                }
            ]
        });
        let live = json!({
            "available": true,
            "pages": [
                {
                    "id": "folder",
                    "title": "Design docs",
                    "kind": "folder",
                    "depth": 0,
                    "expanded": true,
                    "remote": true
                },
                {
                    "id": "live-only",
                    "title": "Just created",
                    "kind": "page",
                    "depth": 1,
                    "expanded": false,
                    "remote": true
                }
            ],
            "canvases": []
        });

        let merged = merge_active_workspace_ui(&live, Some(&cached));
        assert_eq!(
            merged.get("pages"),
            Some(&json!([
                {
                    "id": "folder",
                    "title": "Design docs",
                    "kind": "folder",
                    "depth": 0,
                    "expanded": true,
                    "remote": true
                },
                {
                    "id": "cached-page",
                    "title": "New page",
                    "kind": "page",
                    "depth": 1,
                    "expanded": false,
                    "remote": true
                },
                {
                    "id": "live-only",
                    "title": "Just created",
                    "kind": "page",
                    "depth": 1,
                    "expanded": false,
                    "remote": true
                },
                {
                    "id": "other-folder",
                    "title": "Other",
                    "kind": "folder",
                    "depth": 0,
                    "expanded": false,
                    "remote": true
                }
            ]))
        );
    }

    #[test]
    fn keeps_cached_pages_that_are_outside_the_rendered_sidebar_slice() {
        let cached = json!({
            "pages": [
                {
                    "id": "offscreen-above",
                    "title": "Above the viewport",
                    "kind": "page",
                    "depth": 0,
                    "expanded": false,
                    "remote": false
                },
                {
                    "id": "visible-page",
                    "title": "Visible old title",
                    "kind": "page",
                    "depth": 0,
                    "expanded": false,
                    "remote": false
                },
                {
                    "id": "offscreen-below",
                    "title": "Below the viewport",
                    "kind": "page",
                    "depth": 0,
                    "expanded": false,
                    "remote": false
                }
            ]
        });
        let live = json!({
            "available": true,
            "pages": [
                {
                    "id": "visible-page",
                    "title": "Visible new title",
                    "kind": "page",
                    "depth": 0,
                    "expanded": false
                }
            ]
        });

        let merged = merge_active_workspace_ui(&live, Some(&cached));
        let ids = merged["pages"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|page| page["id"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            vec!["offscreen-above", "visible-page", "offscreen-below"]
        );
        assert_eq!(merged["pages"][1]["title"], "Visible new title");
    }

    #[test]
    fn complete_live_page_scan_is_authoritative_for_deletions() {
        let cached = json!({
            "pages": [
                {
                    "id": "deleted-phase",
                    "title": "Deleted phase",
                    "kind": "page",
                    "depth": 0,
                    "expanded": false,
                    "remote": false
                },
                {
                    "id": "kept-page",
                    "title": "Old title",
                    "kind": "page",
                    "depth": 0,
                    "expanded": false,
                    "remote": false
                }
            ]
        });
        let live = json!({
            "available": true,
            "pagesComplete": true,
            "pages": [
                {
                    "id": "kept-page",
                    "title": "Current title",
                    "kind": "page",
                    "depth": 0,
                    "expanded": false
                }
            ]
        });

        let merged = merge_active_workspace_ui(&live, Some(&cached));
        assert_eq!(merged["pages"].as_array().unwrap().len(), 1);
        assert_eq!(merged["pages"][0]["id"], "kept-page");
        assert_eq!(merged["pages"][0]["title"], "Current title");
    }

    #[test]
    fn verified_page_tree_replaces_the_stale_http_cache() {
        let workspace_id = "cffd6a63-0ef8-4a7e-9ce5-d588cee6135f";
        let mut catalog = CachedWorkspaceCatalog {
            names: HashMap::new(),
            pages: HashMap::from([(
                workspace_id.to_owned(),
                json!({ "pages": [{ "id": "deleted-phase" }] }),
            )]),
        };
        apply_verified_workspace_pages(
            &mut catalog,
            &HashMap::from([(
                workspace_id.to_owned(),
                json!({ "pages": [{ "id": "current-page" }] }),
            )]),
        );

        assert_eq!(
            catalog.pages[workspace_id]["pages"][0]["id"],
            "current-page"
        );
    }

    #[test]
    fn active_workspace_never_uses_unverified_http_pages() {
        let stale = json!({ "pages": [{ "id": "deleted-phase" }], "cached": true });
        let verified = json!({
            "pages": [{ "id": "current-page" }],
            "verified": true
        });

        assert!(verified_workspace_ui(Some(&stale)).is_none());
        assert_eq!(
            verified_workspace_ui(Some(&verified)).unwrap()["pages"][0]["id"],
            "current-page"
        );
    }

    #[test]
    fn uses_the_complete_cached_catalog_for_deletes_moves_and_order() {
        let cached = json!({
            "pages": [
                {
                    "id": "root-page",
                    "title": "Root page",
                    "kind": "page",
                    "depth": 0,
                    "expanded": false,
                    "remote": false
                },
                {
                    "id": "kept-folder",
                    "title": "Kept",
                    "kind": "folder",
                    "depth": 0,
                    "expanded": false,
                    "remote": false
                },
                {
                    "id": "hidden-page",
                    "title": "Hidden child",
                    "kind": "page",
                    "depth": 1,
                    "expanded": false,
                    "remote": false
                },
                {
                    "id": "moved-page",
                    "title": "Moved page",
                    "kind": "page",
                    "depth": 0,
                    "expanded": false,
                    "remote": false
                },
                {
                    "id": "created-page",
                    "title": "Just created",
                    "kind": "page",
                    "depth": 0,
                    "expanded": false,
                    "remote": false
                }
            ]
        });
        let live = json!({
            "available": true,
            "pages": [
                {
                    "id": "root-page",
                    "title": "Root page renamed",
                    "kind": "page",
                    "depth": 0,
                    "expanded": false
                },
                {
                    "id": "kept-folder",
                    "title": "Kept",
                    "kind": "folder",
                    "depth": 0,
                    "expanded": false
                }
            ]
        });

        let merged = merge_active_workspace_ui(&live, Some(&cached));
        assert_eq!(
            merged.get("pages"),
            Some(&json!([
                {
                    "id": "root-page",
                    "title": "Root page renamed",
                    "kind": "page",
                    "depth": 0,
                    "expanded": false,
                    "remote": true
                },
                {
                    "id": "kept-folder",
                    "title": "Kept",
                    "kind": "folder",
                    "depth": 0,
                    "expanded": false,
                    "remote": true
                },
                {
                    "id": "hidden-page",
                    "title": "Hidden child",
                    "kind": "page",
                    "depth": 1,
                    "expanded": false,
                    "remote": true
                },
                {
                    "id": "moved-page",
                    "title": "Moved page",
                    "kind": "page",
                    "depth": 0,
                    "expanded": false,
                    "remote": true
                },
                {
                    "id": "created-page",
                    "title": "Just created",
                    "kind": "page",
                    "depth": 0,
                    "expanded": false,
                    "remote": true
                }
            ]))
        );
    }
}
