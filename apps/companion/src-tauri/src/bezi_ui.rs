use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
};

use serde_json::{json, Value};

const UI_HELPER: &str = include_str!("../scripts/bezi-ui.ps1");
static UI_HELPER_FILE: OnceLock<Result<PathBuf, String>> = OnceLock::new();
static UI_HELPER_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Default)]
struct SelectionContext<'a> {
    label: Option<&'a str>,
    session_id: Option<&'a str>,
    workspace_id: Option<&'a str>,
    workspace_label: Option<&'a str>,
    complete_pages: bool,
}

pub fn snapshot(project_ids: &HashSet<String>, canvas_root: &Path, complete_pages: bool) -> Value {
    match run_helper_with_selection(
        "snapshot",
        None,
        &[],
        project_ids,
        canvas_root,
        SelectionContext {
            complete_pages,
            ..SelectionContext::default()
        },
    ) {
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
    run_helper("activate", Some(item_id), &[], &project_ids, &canvas_root).map(|_| ())
}

pub fn activate_workspace(workspace_id: &str, label: &str) -> Result<(), String> {
    if !looks_like_uuid(workspace_id) {
        return Err("The requested Bezi workspace identifier is invalid".to_owned());
    }
    validate_selection_label(label, "workspace")?;
    let project_ids = HashSet::new();
    let canvas_root = PathBuf::new();
    run_helper_with_selection(
        "activate-workspace",
        Some(workspace_id),
        &[],
        &project_ids,
        &canvas_root,
        SelectionContext {
            label: Some(label),
            ..SelectionContext::default()
        },
    )
    .map(|_| ())
}

pub fn activate_thread(
    session_id: &str,
    thread_id: Option<&str>,
    title: &str,
    workspace_id: Option<&str>,
    workspace_label: Option<&str>,
) -> Result<(), String> {
    if !looks_like_uuid(session_id) || thread_id.is_some_and(|id| !looks_like_uuid(id)) {
        return Err("The requested Bezi thread identifier is invalid".to_owned());
    }
    validate_selection_label(title, "thread")?;
    if workspace_id.is_some_and(|id| !looks_like_uuid(id)) {
        return Err("The requested Bezi workspace identifier is invalid".to_owned());
    }
    if let Some(label) = workspace_label {
        validate_selection_label(label, "workspace")?;
    }
    if workspace_id.is_some() != workspace_label.is_some() {
        return Err("The requested Bezi thread workspace is incomplete".to_owned());
    }

    let active_workspace_id = crate::bezi::current_workspace_id();
    let switch_workspace = workspace_id.is_some_and(|requested| {
        workspace_switch_required(active_workspace_id.as_deref(), requested)
    });
    let helper_workspace_id = switch_workspace.then_some(workspace_id).flatten();
    let helper_workspace_label = switch_workspace.then_some(workspace_label).flatten();

    let project_ids = HashSet::new();
    let canvas_root = PathBuf::new();
    run_helper_with_selection(
        "activate-thread",
        thread_id.or(Some(session_id)),
        &[],
        &project_ids,
        &canvas_root,
        SelectionContext {
            label: Some(title),
            session_id: Some(session_id),
            workspace_id: helper_workspace_id,
            workspace_label: helper_workspace_label,
            ..SelectionContext::default()
        },
    )
    .map(|_| ())
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
        &[],
        &project_ids,
        &canvas_root,
    )
    .map(|_| ())
}

pub fn read_page(item_id: &str, ancestor_ids: &[String]) -> Result<Value, String> {
    if !looks_like_uuid(item_id) {
        return Err("The requested Bezi page identifier is invalid".to_owned());
    }
    if ancestor_ids.len() > 16 || ancestor_ids.iter().any(|id| !looks_like_uuid(id)) {
        return Err("The requested Bezi page folder path is invalid".to_owned());
    }
    let project_ids = HashSet::new();
    let canvas_root = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .map(|path| path.join("com.bezi.app").join("canvases"))
        .unwrap_or_default();
    run_helper(
        "read-page",
        Some(item_id),
        ancestor_ids,
        &project_ids,
        &canvas_root,
    )
}

fn run_helper(
    action: &str,
    item_id: Option<&str>,
    ancestor_ids: &[String],
    project_ids: &HashSet<String>,
    canvas_root: &Path,
) -> Result<Value, String> {
    run_helper_with_selection(
        action,
        item_id,
        ancestor_ids,
        project_ids,
        canvas_root,
        SelectionContext::default(),
    )
}

fn run_helper_with_selection(
    action: &str,
    item_id: Option<&str>,
    ancestor_ids: &[String],
    project_ids: &HashSet<String>,
    canvas_root: &Path,
    selection: SelectionContext<'_>,
) -> Result<Value, String> {
    if !cfg!(windows) {
        return Err("Bezi semantic window control is available only on Windows".to_owned());
    }
    let _guard = UI_HELPER_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "The Bezi UI helper lock is unavailable".to_owned())?;
    let process_id = crate::bezi::read_descriptor()?.pid;
    let helper_path = ui_helper_path()?;
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(helper_path)
        .env("BEZI_REMOTE_UI_ACTION", action)
        .env("BEZI_REMOTE_UI_ITEM", item_id.unwrap_or_default())
        .env("BEZI_REMOTE_UI_LABEL", selection.label.unwrap_or_default())
        .env(
            "BEZI_REMOTE_UI_SESSION",
            selection.session_id.unwrap_or_default(),
        )
        .env(
            "BEZI_REMOTE_UI_WORKSPACE",
            selection.workspace_id.unwrap_or_default(),
        )
        .env(
            "BEZI_REMOTE_UI_WORKSPACE_LABEL",
            selection.workspace_label.unwrap_or_default(),
        )
        .env(
            "BEZI_REMOTE_UI_COMPLETE_PAGES",
            if selection.complete_pages { "1" } else { "0" },
        )
        .env("BEZI_REMOTE_UI_ANCESTORS", ancestor_ids.join(","))
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
        let raw_message = String::from_utf8_lossy(&output.stderr);
        let message = concise_helper_error(&raw_message);
        return Err(if message.is_empty() {
            "The Bezi UI helper failed".to_owned()
        } else {
            message
        });
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| "The Bezi UI helper returned an invalid response".to_owned())
}

fn ui_helper_path() -> Result<&'static Path, String> {
    match UI_HELPER_FILE.get_or_init(|| {
        let path =
            std::env::temp_dir().join(format!("bezi-remote-ui-helper-{}.ps1", std::process::id()));
        fs::write(&path, UI_HELPER).map_err(|error| {
            format!(
                "Could not prepare the Bezi UI helper at {}: {error}",
                path.display()
            )
        })?;
        Ok(path)
    }) {
        Ok(path) => Ok(path.as_path()),
        Err(error) => Err(error.clone()),
    }
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

fn validate_selection_label(value: &str, kind: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.len() > 256
        || value
            .chars()
            .any(|character| matches!(character, '\r' | '\n' | '\0'))
    {
        return Err(format!("The requested Bezi {kind} label is invalid"));
    }
    Ok(())
}

fn workspace_switch_required(active_workspace_id: Option<&str>, requested: &str) -> bool {
    active_workspace_id != Some(requested)
}

fn concise_helper_error(value: &str) -> String {
    value
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_uuid_shaped_tree_items() {
        assert!(looks_like_uuid("22b56374-503c-450b-aa3a-447de6e91579"));
        assert!(!looks_like_uuid("Private Pages"));
    }

    #[test]
    fn accepts_only_short_single_line_selection_labels() {
        assert!(validate_selection_label("Demo", "workspace").is_ok());
        assert!(validate_selection_label("", "workspace").is_err());
        assert!(validate_selection_label("Demo\nOther", "workspace").is_err());
        assert!(validate_selection_label(&"x".repeat(257), "workspace").is_err());
    }

    #[test]
    fn helper_supports_explicit_thread_and_workspace_actions() {
        assert!(UI_HELPER.contains("activate-thread"));
        assert!(UI_HELPER.contains("activate-workspace"));
        assert!(UI_HELPER.contains("Open-BeziSelectionMenu"));
    }

    #[test]
    fn helper_resolves_id_bearing_rows_to_actionable_descendants() {
        assert!(UI_HELPER.contains("Find-BeziActionableDescendant"));
        assert!(UI_HELPER.contains("$name.StartsWith("));
        assert!(UI_HELPER.contains("Test-BeziInvokePattern"));
    }

    #[test]
    fn helper_scrolls_virtualized_selectors_to_find_hidden_rows() {
        assert!(UI_HELPER.contains("Find-BeziSelectionElementWithScroll"));
        assert!(UI_HELPER.contains("ScrollPattern"));
        assert!(UI_HELPER.contains("-Selector $selector"));
    }

    #[test]
    fn helper_can_exhaustively_scan_and_restore_the_page_tree() {
        assert!(UI_HELPER.contains("Get-BeziCompletePageTree"));
        assert!(UI_HELPER.contains("BEZI_REMOTE_UI_COMPLETE_PAGES"));
        assert!(UI_HELPER.contains("pagesComplete"));
        assert!(UI_HELPER.contains("$foldersExpandedByScan"));
    }

    #[test]
    fn complete_scan_can_expand_before_the_page_list_becomes_scrollable() {
        assert!(UI_HELPER.contains("Get-BeziPageScrollPattern"));
        assert!(UI_HELPER.contains("$scroll = Get-BeziPageScrollPattern"));
        assert!(!UI_HELPER
            .contains("catch {\n        return $emptyResult\n    }\n\n    $originalScrollPercent"));
    }

    #[test]
    fn helper_checks_the_visible_workspace_before_switching() {
        assert!(UI_HELPER.contains("Test-BeziElementContainsLabel"));
        assert!(UI_HELPER.contains("-Target $selector -Label $WorkspaceLabel"));
        assert!(UI_HELPER.contains("$WorkspaceLabel"));
    }

    #[test]
    fn threads_skip_workspace_ui_when_the_workspace_id_is_already_active() {
        let workspace = "cffd6a63-0ef8-4a7e-9ce5-d588cee6135f";
        assert!(!workspace_switch_required(Some(workspace), workspace));
        assert!(workspace_switch_required(
            Some("e076ae2d-13e4-4fef-8a2c-7eba3ccb7fa4"),
            workspace,
        ));
        assert!(workspace_switch_required(None, workspace));
    }

    #[test]
    fn helper_does_not_treat_the_sidebar_toggle_as_the_workspace_selector() {
        assert!(!UI_HELPER.contains("$button.Current.Name -ceq \"Workspace\""));
        assert!(UI_HELPER.contains("$rectangle.Width -gt 120"));
    }

    #[test]
    fn trims_powershell_diagnostics_from_mobile_errors() {
        assert_eq!(
            concise_helper_error(
                "The requested Bezi workspace is unavailable.\r\nAt C:\\Temp\\helper.ps1:10 char:5\r\n+ throw"
            ),
            "The requested Bezi workspace is unavailable."
        );
    }
}
