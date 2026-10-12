use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::State;

/// Tabs and their chats, transcripts included. Larger is refused.
const MAX_PAYLOAD_BYTES: usize = 64 * 1024 * 1024;
/// A window opened from a transfer takes the payload as it boots. One left
/// longer than this was never taken (the window failed to open), so a later
/// New Window must not pick it up.
const PAYLOAD_TTL: Duration = Duration::from_secs(60);

pub struct WindowTransferState(Mutex<Option<(String, Instant)>>);

impl WindowTransferState {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

fn check_payload(payload: &str) -> Result<(), String> {
    if payload.trim().is_empty() {
        return Err("empty window transfer payload".into());
    }
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err("window transfer payload is too large".into());
    }
    Ok(())
}

fn take_fresh(slot: &mut Option<(String, Instant)>, now: Instant) -> Option<String> {
    match slot.take() {
        Some((payload, staged)) if now.saturating_duration_since(staged) <= PAYLOAD_TTL => {
            Some(payload)
        }
        _ => None,
    }
}

#[tauri::command]
pub fn stage_window_transfer(
    state: State<'_, WindowTransferState>,
    payload: String,
) -> Result<(), String> {
    check_payload(&payload)?;
    *state.0.lock().map_err(|err| err.to_string())? = Some((payload, Instant::now()));
    Ok(())
}

#[tauri::command]
pub fn take_window_transfer(
    state: State<'_, WindowTransferState>,
) -> Result<Option<String>, String> {
    let mut slot = state.0.lock().map_err(|err| err.to_string())?;
    Ok(take_fresh(&mut slot, Instant::now()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_empty_and_oversized_payloads() {
        assert!(check_payload("").is_err());
        assert!(check_payload("  \n").is_err());
        assert!(check_payload("{}").is_ok());
        assert!(check_payload(&"x".repeat(MAX_PAYLOAD_BYTES + 1)).is_err());
    }

    #[test]
    fn a_payload_is_taken_once_and_only_while_fresh() {
        let now = Instant::now();
        let mut slot = Some(("{}".to_string(), now));
        assert_eq!(
            take_fresh(&mut slot, now + Duration::from_secs(1)),
            Some("{}".into())
        );
        assert_eq!(take_fresh(&mut slot, now), None);

        let mut stale = Some(("{}".to_string(), now));
        assert_eq!(
            take_fresh(&mut stale, now + PAYLOAD_TTL + Duration::from_secs(1)),
            None
        );
        assert!(stale.is_none());

        let mut empty = None;
        assert_eq!(take_fresh(&mut empty, now), None);
    }
}
