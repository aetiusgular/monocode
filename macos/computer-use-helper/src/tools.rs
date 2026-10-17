//! Which driver tools pass through the helper. MonoCode keeps the same list in
//! `src-tauri/src/computer_use/manifest.rs`, and a test there checks the two
//! match, name for name.

/// Tools MonoCode may call for an agent.
pub const ALLOWED_TOOLS: &[&str] = &[
    "list_apps",
    "list_windows",
    "launch_app",
    "kill_app",
    "bring_to_front",
    "set_window_frame",
    "invoke_menu",
    "get_window_state",
    "get_accessibility_tree",
    "verify_state",
    "parse_visual_regions",
    "get_screen_size",
    "get_cursor_position",
    "zoom",
    "click",
    "double_click",
    "right_click",
    "drag",
    "scroll",
    "move_cursor",
    "type_text",
    "press_key",
    "hotkey",
    "set_value",
    "start_session",
    "get_session",
    "end_session",
];

/// Tools the helper calls itself, on its own connection, and never relays.
pub const HELPER_ONLY_TOOLS: &[&str] =
    &["start_recording", "stop_recording", "get_recording_state"];

pub fn relayable(name: &str) -> bool {
    ALLOWED_TOOLS.contains(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_is_never_relayed() {
        for tool in HELPER_ONLY_TOOLS {
            assert!(!relayable(tool));
        }
        assert!(!relayable("get_desktop_state"));
        assert!(!relayable("set_config"));
        assert!(relayable("click"));
    }
}
