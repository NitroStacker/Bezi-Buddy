use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast;

use crate::control::ControlState;

#[cfg(feature = "native-streaming")]
use crate::stream_native::NativeMediaManager;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStatus {
    pub available: bool,
    pub dependencies_ready: bool,
    pub capture_backend: Option<String>,
    pub encoder: Option<String>,
    pub audio_backend: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Copy)]
pub enum StreamPreset {
    Editor,
    Game,
    Balanced,
    DataSaver,
}

#[derive(Debug, Clone, Copy)]
pub struct CaptureRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

#[cfg(feature = "native-streaming")]
#[derive(Debug, Clone, Copy)]
pub struct CaptureWindow {
    pub handle: u64,
    pub client_x: i32,
    pub client_y: i32,
    pub width: i32,
    pub height: i32,
}

#[cfg(feature = "native-streaming")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureCrop {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[cfg(feature = "native-streaming")]
impl CaptureWindow {
    pub fn crop(self, region: Option<CaptureRegion>) -> Result<Option<CaptureCrop>, String> {
        let Some(region) = region else {
            return Ok(None);
        };
        let requested_left = (region.x * region.scale).round() as i32 - self.client_x;
        let requested_top = (region.y * region.scale).round() as i32 - self.client_y;
        let requested_right = requested_left + (region.width * region.scale).round() as i32;
        let requested_bottom = requested_top + (region.height * region.scale).round() as i32;
        let left = requested_left.clamp(0, self.width.saturating_sub(2));
        let top = requested_top.clamp(0, self.height.saturating_sub(2));
        let end_x = requested_right.clamp(left + 2, self.width);
        let end_y = requested_bottom.clamp(top + 2, self.height);
        if end_x <= left || end_y <= top {
            return Err("The selected Unity view is outside the Editor capture window".to_owned());
        }
        Ok(Some(CaptureCrop {
            left,
            top,
            right: self.width - end_x,
            bottom: self.height - end_y,
        }))
    }
}

#[cfg(feature = "native-streaming")]
pub struct StreamProfile {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
}

impl StreamPreset {
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("game") => Self::Game,
            Some("balanced") => Self::Balanced,
            Some("dataSaver") | Some("data-saver") => Self::DataSaver,
            _ => Self::Editor,
        }
    }

    #[cfg(feature = "native-streaming")]
    pub fn profile(self) -> StreamProfile {
        match self {
            Self::Editor => StreamProfile {
                width: 1920,
                height: 1080,
                fps: 30,
                bitrate_kbps: 8_000,
            },
            Self::Game => StreamProfile {
                width: 1280,
                height: 720,
                fps: 60,
                bitrate_kbps: 8_000,
            },
            Self::Balanced => StreamProfile {
                width: 1280,
                height: 720,
                fps: 30,
                bitrate_kbps: 4_000,
            },
            Self::DataSaver => StreamProfile {
                width: 854,
                height: 480,
                fps: 30,
                bitrate_kbps: 1_500,
            },
        }
    }
}

#[derive(Debug, Clone)]
pub struct StreamEvent {
    pub device_id: String,
    pub request_id: String,
    pub message_type: String,
    pub body: Value,
}

impl StreamEvent {
    #[cfg(feature = "native-streaming")]
    pub fn new(device_id: &str, request_id: &str, message_type: &str, body: Value) -> Self {
        Self {
            device_id: device_id.to_owned(),
            request_id: request_id.to_owned(),
            message_type: message_type.to_owned(),
            body,
        }
    }

    pub fn payload(self) -> Value {
        serde_json::json!({
            "v": 1,
            "requestId": self.request_id,
            "type": self.message_type,
            "body": self.body
        })
    }
}

#[derive(Clone)]
pub struct MediaManager {
    #[cfg(feature = "native-streaming")]
    native: Option<NativeMediaManager>,
    events: broadcast::Sender<StreamEvent>,
    init_error: Option<String>,
}

impl MediaManager {
    pub fn new(control: Arc<ControlState>) -> Self {
        let (events, _) = broadcast::channel(1);
        #[cfg(feature = "native-streaming")]
        {
            return match NativeMediaManager::new(control) {
                Ok(native) => Self {
                    native: Some(native),
                    events,
                    init_error: None,
                },
                Err(error) => Self {
                    native: None,
                    events,
                    init_error: Some(error),
                },
            };
        }
        #[cfg(not(feature = "native-streaming"))]
        {
            let _ = control;
            Self {
                events,
                init_error: Some(
                    "This companion was built without native media support".to_owned(),
                ),
            }
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<StreamEvent> {
        #[cfg(feature = "native-streaming")]
        {
            if let Some(native) = &self.native {
                return native.subscribe();
            }
        }
        self.events.subscribe()
    }

    pub fn start(
        &self,
        device_id: &str,
        request_id: &str,
        process_id: u32,
        region: Option<CaptureRegion>,
        preset: StreamPreset,
    ) -> Result<(), String> {
        let status = probe();
        if !status.available {
            return Err(status.reason);
        }
        #[cfg(feature = "native-streaming")]
        {
            return self.native.as_ref().map_or_else(
                || {
                    Err(self
                        .init_error
                        .clone()
                        .unwrap_or_else(|| "Native media is unavailable".to_owned()))
                },
                |native| native.start(device_id, request_id, process_id, region, preset, &status),
            );
        }
        #[cfg(not(feature = "native-streaming"))]
        {
            let _ = (device_id, request_id, process_id, region, preset);
            Err(self
                .init_error
                .clone()
                .unwrap_or_else(|| "Native media is unavailable".to_owned()))
        }
    }

    pub fn set_answer(&self, device_id: &str, sdp: &str) -> Result<(), String> {
        #[cfg(feature = "native-streaming")]
        {
            return self.native.as_ref().map_or_else(
                || Err("Native media is unavailable".to_owned()),
                |native| native.set_answer(device_id, sdp),
            );
        }
        #[cfg(not(feature = "native-streaming"))]
        {
            let _ = (device_id, sdp);
            Err("This companion was built without native media support".to_owned())
        }
    }

    pub fn add_ice_candidate(
        &self,
        device_id: &str,
        sdp_m_line_index: u32,
        candidate: &str,
    ) -> Result<(), String> {
        #[cfg(feature = "native-streaming")]
        {
            return self.native.as_ref().map_or_else(
                || Err("Native media is unavailable".to_owned()),
                |native| native.add_ice_candidate(device_id, sdp_m_line_index, candidate),
            );
        }
        #[cfg(not(feature = "native-streaming"))]
        {
            let _ = (device_id, sdp_m_line_index, candidate);
            Err("This companion was built without native media support".to_owned())
        }
    }

    pub fn stop(&self, device_id: &str) {
        #[cfg(feature = "native-streaming")]
        if let Some(native) = &self.native {
            native.stop(device_id);
        }
        #[cfg(not(feature = "native-streaming"))]
        let _ = device_id;
    }

    pub fn stop_all(&self) {
        #[cfg(feature = "native-streaming")]
        if let Some(native) = &self.native {
            native.stop_all();
        }
    }
}

impl StreamStatus {
    pub fn capabilities(&self) -> &'static [&'static str] {
        if self.available {
            &[
                "bezi.remote",
                "unity.remote",
                "stream.video",
                "stream.audio",
            ]
        } else {
            &[]
        }
    }
}

pub fn probe() -> StreamStatus {
    let Some(inspector) = find_gstreamer_inspector() else {
        return StreamStatus {
            available: false,
            dependencies_ready: false,
            capture_backend: None,
            encoder: None,
            audio_backend: None,
            reason:
                "GStreamer 1.x is not installed. Semantic Bezi and Unity control remains available."
                    .to_owned(),
        };
    };

    let capture_backend = first_plugin(
        &inspector,
        &["d3d12screencapturesrc", "d3d11screencapturesrc"],
    );
    let encoder = first_plugin(
        &inspector,
        &[
            "nvh264enc",
            "mfh264enc",
            "qsvh264enc",
            "amfh264enc",
            "openh264enc",
            "x264enc",
        ],
    );
    let audio_backend = first_plugin(&inspector, &["wasapi2src", "wasapisrc"]);
    let webrtc = plugin_exists(&inspector, "webrtcbin");
    let dependencies_ready =
        capture_backend.is_some() && encoder.is_some() && audio_backend.is_some() && webrtc;

    StreamStatus {
        available: dependencies_ready && cfg!(feature = "native-streaming"),
        dependencies_ready,
        capture_backend,
        encoder,
        audio_backend,
        reason: if dependencies_ready && cfg!(feature = "native-streaming") {
            "Native window capture, H.264, Opus, and WebRTC negotiation are ready.".to_owned()
        } else if dependencies_ready {
            "Capture dependencies are installed, but this companion was built without the native-streaming feature."
                .to_owned()
        } else {
            "GStreamer is installed but the Windows capture, WebRTC, audio, or H.264 plugin set is incomplete."
                .to_owned()
        },
    }
}

#[cfg(all(windows, feature = "native-streaming"))]
pub fn find_target_window(process_id: u32) -> Result<CaptureWindow, String> {
    use windows::core::BOOL;
    use windows::Win32::{
        Foundation::{HWND, LPARAM, POINT, RECT},
        Graphics::Gdi::ClientToScreen,
        UI::WindowsAndMessaging::{
            EnumWindows, GetClientRect, GetWindow, GetWindowRect, GetWindowTextLengthW,
            GetWindowThreadProcessId, IsWindowVisible, GW_OWNER,
        },
    };

    struct Search {
        process_id: u32,
        best: Option<(u64, i64)>,
    }

    unsafe extern "system" fn visit(hwnd: HWND, parameter: LPARAM) -> BOOL {
        let search = unsafe { &mut *(parameter.0 as *mut Search) };
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() || unsafe { GetWindowTextLengthW(hwnd) } <= 0
        {
            return BOOL(1);
        }
        let mut owner_pid = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut owner_pid));
        }
        if owner_pid != search.process_id
            || unsafe { GetWindow(hwnd, GW_OWNER) }.is_ok_and(|owner| !owner.0.is_null())
        {
            return BOOL(1);
        }
        let mut rect = RECT::default();
        if unsafe { GetWindowRect(hwnd, &mut rect) }.is_ok() {
            let width = i64::from((rect.right - rect.left).max(0));
            let height = i64::from((rect.bottom - rect.top).max(0));
            let area = width * height;
            if search.best.is_none_or(|(_, best_area)| area > best_area) {
                search.best = Some((hwnd.0 as usize as u64, area));
            }
        }
        BOOL(1)
    }

    let mut search = Search {
        process_id,
        best: None,
    };
    unsafe {
        EnumWindows(
            Some(visit),
            LPARAM((&mut search as *mut Search).cast::<std::ffi::c_void>() as isize),
        )
    }
    .map_err(|error| format!("Could not enumerate Windows application windows: {error}"))?;
    let handle = search
        .best
        .map(|(window, _)| window)
        .ok_or_else(|| "The selected application has no visible capture window".to_owned())?;
    let hwnd = HWND(handle as usize as *mut std::ffi::c_void);
    let mut client = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client) }
        .map_err(|error| format!("Could not read the capture window client bounds: {error}"))?;
    let mut origin = POINT::default();
    if !unsafe { ClientToScreen(hwnd, &mut origin) }.as_bool() {
        return Err("Could not resolve the capture window screen position".to_owned());
    }
    Ok(CaptureWindow {
        handle,
        client_x: origin.x,
        client_y: origin.y,
        width: client.right - client.left,
        height: client.bottom - client.top,
    })
}

#[cfg(all(not(windows), feature = "native-streaming"))]
pub fn find_target_window(_process_id: u32) -> Result<CaptureWindow, String> {
    Err("Window capture is available only on Windows".to_owned())
}

fn first_plugin(inspector: &Path, candidates: &[&str]) -> Option<String> {
    candidates
        .iter()
        .find(|candidate| plugin_exists(inspector, candidate))
        .map(|candidate| (*candidate).to_owned())
}

fn plugin_exists(inspector: &Path, plugin: &str) -> bool {
    Command::new(inspector)
        .arg(plugin)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn find_gstreamer_inspector() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("BEZI_REMOTE_GST_INSPECT") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }

    let candidates = [
        PathBuf::from("gst-inspect-1.0.exe"),
        PathBuf::from(r"C:\gstreamer\1.0\msvc_x86_64\bin\gst-inspect-1.0.exe"),
        PathBuf::from(r"C:\Program Files\gstreamer\1.0\msvc_x86_64\bin\gst-inspect-1.0.exe"),
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_default()
            .join(r"Programs\gstreamer\1.0\msvc_x86_64\bin\gst-inspect-1.0.exe"),
    ];
    candidates.into_iter().find(|candidate| {
        Command::new(candidate)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    })
}

#[cfg(all(test, feature = "native-streaming"))]
mod capture_tests {
    use super::{CaptureCrop, CaptureRegion, CaptureWindow};

    #[test]
    fn unity_logical_viewport_is_scaled_and_cropped_to_client_pixels() {
        let window = CaptureWindow {
            handle: 42,
            client_x: 0,
            client_y: 75,
            width: 3840,
            height: 2048,
        };
        let crop = window
            .crop(Some(CaptureRegion {
                x: 416.0,
                y: 86.0,
                width: 1408.0,
                height: 766.0,
                scale: 1.5,
            }))
            .expect("crop should resolve");

        assert_eq!(
            crop,
            Some(CaptureCrop {
                left: 624,
                top: 54,
                right: 1104,
                bottom: 845,
            })
        );
    }

    #[test]
    fn absent_viewport_keeps_full_window_capture() {
        let window = CaptureWindow {
            handle: 42,
            client_x: 0,
            client_y: 0,
            width: 1920,
            height: 1080,
        };
        assert_eq!(
            window.crop(None).expect("full capture should resolve"),
            None
        );
    }
}

#[cfg(test)]
mod tests {
    use super::StreamStatus;

    #[test]
    fn unavailable_stream_never_advertises_remote_capabilities() {
        let status = StreamStatus {
            available: false,
            dependencies_ready: true,
            capture_backend: Some("d3d11screencapturesrc".to_owned()),
            encoder: Some("nvh264enc".to_owned()),
            audio_backend: Some("wasapi2src".to_owned()),
            reason: "not negotiated".to_owned(),
        };

        assert!(status.capabilities().is_empty());
    }
}
