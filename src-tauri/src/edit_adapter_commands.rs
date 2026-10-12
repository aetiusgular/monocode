//! Tauri commands for the edit adapter (session 10). Kept apart from
//! `edit_adapter.rs` so that module builds without Tauri, for the small
//! contract-check example.

use crate::edit_adapter::{close_route, open_route};

/// Opens or reuses the adapter route for a Codex session and returns the base
/// URL Codex should use for its model provider.
#[tauri::command]
pub fn edit_adapter_open(
    session_id: String,
    upstream: String,
    cwd: String,
) -> Result<String, String> {
    open_route(&session_id, &upstream, &cwd)
}

/// Closes a session's route.
#[tauri::command]
pub fn edit_adapter_close(session_id: String) {
    close_route(&session_id);
}
