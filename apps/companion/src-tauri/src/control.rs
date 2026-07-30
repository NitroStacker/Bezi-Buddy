use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct ControlState {
    armed: AtomicBool,
    deadline: Mutex<Option<Instant>>,
    held_keys: Mutex<HashSet<u16>>,
    held_buttons: Mutex<HashSet<u8>>,
}

impl ControlState {
    pub fn arm(&self, duration: Duration) {
        self.armed.store(true, Ordering::Release);
        *self.deadline.lock().expect("control deadline poisoned") =
            Some(Instant::now() + duration.min(Duration::from_secs(60)));
    }

    pub fn is_armed(&self) -> bool {
        if !self.armed.load(Ordering::Acquire) {
            return false;
        }
        let expired = self
            .deadline
            .lock()
            .expect("control deadline poisoned")
            .is_some_and(|deadline| deadline <= Instant::now());
        if expired {
            self.disarm();
            return false;
        }
        true
    }

    pub fn track_key_down(&self, virtual_key: u16) -> Result<(), String> {
        if !self.is_armed() {
            return Err("Remote control is not armed".to_owned());
        }
        self.held_keys
            .lock()
            .map_err(|_| "Input state is unavailable".to_owned())?
            .insert(virtual_key);
        Ok(())
    }

    pub fn apply_remote_input(&self, body: &serde_json::Value) -> Result<(), String> {
        if !self.is_armed() {
            return Err("Remote control is not armed".to_owned());
        }
        apply_input(self, body)
    }

    pub fn disarm(&self) {
        self.armed.store(false, Ordering::Release);
        *self.deadline.lock().expect("control deadline poisoned") = None;
        self.release_all();
    }

    fn release_all(&self) {
        let keys: Vec<u16> = self
            .held_keys
            .lock()
            .map(|mut keys| keys.drain().collect())
            .unwrap_or_default();
        let buttons: Vec<u8> = self
            .held_buttons
            .lock()
            .map(|mut buttons| buttons.drain().collect())
            .unwrap_or_default();
        release_held_inputs(&keys, &buttons);
    }
}

#[cfg(windows)]
fn apply_input(state: &ControlState, body: &serde_json::Value) -> Result<(), String> {
    use windows::Win32::{
        System::StationsAndDesktops::{
            CloseDesktop, OpenInputDesktop, SwitchDesktop, DESKTOP_CONTROL_FLAGS,
            DESKTOP_SWITCHDESKTOP,
        },
        UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
            MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
            MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL,
            MOUSEINPUT, VIRTUAL_KEY,
        },
    };

    let desktop = unsafe {
        OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_SWITCHDESKTOP)
            .map_err(|_| "Windows is locked or on the secure desktop".to_owned())?
    };
    let interactive = unsafe { SwitchDesktop(desktop).is_ok() };
    let _ = unsafe { CloseDesktop(desktop) };
    if !interactive {
        return Err("Windows is locked or on the secure desktop".to_owned());
    }

    let event = body
        .get("event")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Remote input event is missing".to_owned())?;
    let input = match event {
        "keyDown" | "keyUp" => {
            let key = body
                .get("virtualKey")
                .and_then(serde_json::Value::as_u64)
                .filter(|value| *value <= u16::MAX as u64)
                .ok_or_else(|| "Remote virtual key is invalid".to_owned())?
                as u16;
            if event == "keyDown" {
                state.track_key_down(key)?;
            } else {
                state
                    .held_keys
                    .lock()
                    .map_err(|_| "Input state is unavailable".to_owned())?
                    .remove(&key);
            }
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(key),
                        wScan: 0,
                        dwFlags: if event == "keyUp" {
                            KEYEVENTF_KEYUP
                        } else {
                            Default::default()
                        },
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            }
        }
        "pointerMove" => INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: bounded_i32(body.get("dx"))?,
                    dy: bounded_i32(body.get("dy"))?,
                    mouseData: 0,
                    dwFlags: MOUSEEVENTF_MOVE,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
        "pointerButton" => {
            let button = body
                .get("button")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "Remote pointer button is missing".to_owned())?;
            let down = body
                .get("down")
                .and_then(serde_json::Value::as_bool)
                .ok_or_else(|| "Remote pointer button state is missing".to_owned())?;
            let flags = match (button, down) {
                ("left", true) => MOUSEEVENTF_LEFTDOWN,
                ("left", false) => MOUSEEVENTF_LEFTUP,
                ("right", true) => MOUSEEVENTF_RIGHTDOWN,
                ("right", false) => MOUSEEVENTF_RIGHTUP,
                ("middle", true) => MOUSEEVENTF_MIDDLEDOWN,
                ("middle", false) => MOUSEEVENTF_MIDDLEUP,
                _ => return Err("Remote pointer button is invalid".to_owned()),
            };
            let button_id = match button {
                "left" => 0,
                "right" => 1,
                "middle" => 2,
                _ => return Err("Remote pointer button is invalid".to_owned()),
            };
            let mut held_buttons = state
                .held_buttons
                .lock()
                .map_err(|_| "Input state is unavailable".to_owned())?;
            if down {
                held_buttons.insert(button_id);
            } else {
                held_buttons.remove(&button_id);
            }
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: 0,
                        dy: 0,
                        mouseData: 0,
                        dwFlags: flags,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            }
        }
        "wheel" => INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: (bounded_i32(body.get("delta"))? * 120) as u32,
                    dwFlags: MOUSEEVENTF_WHEEL,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
        _ => return Err("Remote input event is unsupported".to_owned()),
    };
    let sent = unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    if sent != 1 {
        state.disarm();
        return Err("Windows rejected remote input and control was disarmed".to_owned());
    }
    Ok(())
}

#[cfg(windows)]
fn bounded_i32(value: Option<&serde_json::Value>) -> Result<i32, String> {
    let value = value
        .and_then(serde_json::Value::as_i64)
        .filter(|value| (-32_768..=32_768).contains(value))
        .ok_or_else(|| "Remote pointer delta is invalid".to_owned())?;
    Ok(value as i32)
}

#[cfg(not(windows))]
fn apply_input(_state: &ControlState, _body: &serde_json::Value) -> Result<(), String> {
    Err("Remote input is available only on Windows".to_owned())
}

#[cfg(windows)]
fn release_held_inputs(keys: &[u16], buttons: &[u8]) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
        MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTUP, MOUSEINPUT, VIRTUAL_KEY,
    };
    if keys.is_empty() && buttons.is_empty() {
        return;
    }
    let mut inputs: Vec<INPUT> = keys
        .iter()
        .map(|key| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(*key),
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        })
        .collect();
    inputs.extend(buttons.iter().filter_map(|button| {
        let flags = match button {
            0 => MOUSEEVENTF_LEFTUP,
            1 => MOUSEEVENTF_RIGHTUP,
            2 => MOUSEEVENTF_MIDDLEUP,
            _ => return None,
        };
        Some(INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        })
    }));
    unsafe {
        let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(not(windows))]
fn release_held_inputs(_keys: &[u16], _buttons: &[u8]) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expired_control_disarms() {
        let state = ControlState::default();
        state.arm(Duration::ZERO);
        assert!(!state.is_armed());
    }

    #[test]
    fn input_is_rejected_until_armed() {
        let state = ControlState::default();
        assert!(state.track_key_down(65).is_err());
    }

    #[test]
    fn disarm_clears_every_held_input_kind() {
        let state = ControlState::default();
        state.arm(Duration::from_secs(30));
        state.held_keys.lock().unwrap().insert(65);
        state.held_buttons.lock().unwrap().insert(0);
        state.disarm();
        assert!(state.held_keys.lock().unwrap().is_empty());
        assert!(state.held_buttons.lock().unwrap().is_empty());
    }
}
