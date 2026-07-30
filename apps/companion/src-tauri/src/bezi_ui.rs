use std::{
    collections::HashSet,
    path::Path,
    process::{Command, Stdio},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

const UI_HELPER: &str = include_str!("../scripts/bezi-ui.ps1");

pub fn snapshot(project_ids: &HashSet<String>, canvas_root: &Path) -> Value {
    match run_helper("snapshot", None, project_ids, canvas_root) {
        Ok(value) => value,
        Err(error) => json!({
            "available": false,
            "error": error,
            "pages": [],
            "canvases": [],
            "visibleProjectIds": [],
            "navigation": [],
            "activeThreadTitle": Value::Null,
        }),
    }
}

pub fn activate(item_id: &str) -> Result<(), String> {
    if let Some(name) = item_id.strip_prefix("nav:") {
        if !matches!(
            name,
            "Home" | "Your Rules" | "Plans" | "Canvases" | "Shared Pages" | "Private Pages"
        ) {
            return Err("This Bezi navigation item is not remotely allowlisted".to_owned());
        }
    } else if !looks_like_uuid(item_id) {
        return Err("The requested Bezi item identifier is invalid".to_owned());
    }

    let project_ids = HashSet::new();
    let canvas_root = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .map(|path| path.join("com.bezi.app").join("canvases"))
        .unwrap_or_default();
    run_helper("activate", Some(item_id), &project_ids, &canvas_root).map(|_| ())
}

pub fn set_folder_expanded(item_id: &str, expanded: bool) -> Result<(), String> {
    if !looks_like_uuid(item_id) {
        return Err("The requested Bezi folder identifier is invalid".to_owned());
    }
    let project_ids = HashSet::new();
    let canvas_root = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .map(|path| path.join("com.bezi.app").join("canvases"))
        .unwrap_or_default();
    run_helper(
        if expanded {
            "expand-folder"
        } else {
            "collapse-folder"
        },
        Some(item_id),
        &project_ids,
        &canvas_root,
    )
    .map(|_| ())
}

fn run_helper(
    action: &str,
    item_id: Option<&str>,
    project_ids: &HashSet<String>,
    canvas_root: &Path,
) -> Result<Value, String> {
    if !cfg!(windows) {
        return Err("Bezi semantic window control is available only on Windows".to_owned());
    }
    let process_id = crate::bezi::read_descriptor()?.pid;
    let encoded_script = STANDARD.encode(
        UI_HELPER
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded_script,
        ])
        .env("BEZI_REMOTE_UI_ACTION", action)
        .env("BEZI_REMOTE_UI_ITEM", item_id.unwrap_or_default())
        .env("BEZI_REMOTE_BEZI_PID", process_id.to_string())
        .env(
            "BEZI_REMOTE_PROJECT_IDS",
            project_ids.iter().cloned().collect::<Vec<_>>().join(","),
        )
        .env("BEZI_REMOTE_CANVAS_ROOT", canvas_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x0800_0000);
    let output = command
        .output()
        .map_err(|error| format!("Could not start the Bezi UI helper: {error}"))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if message.is_empty() {
            "The Bezi UI helper failed".to_owned()
        } else {
            message
        });
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| "The Bezi UI helper returned an invalid response".to_owned())
}

#[cfg(windows)]
trait HiddenCommand {
    fn creation_flags(&mut self, flags: u32) -> &mut Self;
}

#[cfg(windows)]
impl HiddenCommand for Command {
    fn creation_flags(&mut self, flags: u32) -> &mut Self {
        use std::os::windows::process::CommandExt;
        CommandExt::creation_flags(self, flags);
        self
    }
}

#[cfg(not(windows))]
trait HiddenCommand {
    fn creation_flags(&mut self, _flags: u32) -> &mut Self;
}

#[cfg(not(windows))]
impl HiddenCommand for Command {
    fn creation_flags(&mut self, _flags: u32) -> &mut Self {
        self
    }
}

fn looks_like_uuid(value: &str) -> bool {
    value.len() == 36
        && value
            .chars()
            .enumerate()
            .all(|(index, character)| match index {
                8 | 13 | 18 | 23 => character == '-',
                _ => character.is_ascii_hexdigit(),
            })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_uuid_shaped_tree_items() {
        assert!(looks_like_uuid("22b56374-503c-450b-aa3a-447de6e91579"));
        assert!(!looks_like_uuid("Private Pages"));
    }
}
