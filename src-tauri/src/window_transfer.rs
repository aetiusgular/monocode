use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{State, WebviewWindow};

/// Tabs and their chats, transcripts included. Larger is refused.
const MAX_PAYLOAD_BYTES: usize = 64 * 1024 * 1024;
/// A moved window's own tabs carry no transcripts (those are in the session
/// store), so the main workspace snapshot's limit is plenty.
const MAX_TABS_BYTES: usize = 2_000_000;
/// A staged payload goes to the window opened right after it. One left longer
/// than this was never handed over (the window failed to open), so a later
/// window must not pick it up.
const PAYLOAD_TTL: Duration = Duration::from_secs(60);

/// Windows opened by Move to New Window. The label marks such a window for its
/// whole life, so after a reload it still knows it is not the main window.
/// `windowTransferBootstrap.ts` checks the same prefix.
pub const MOVED_WINDOW_PREFIX: &str = "moved-";

pub fn is_moved_window(label: &str) -> bool {
    label.starts_with(MOVED_WINDOW_PREFIX)
}

/// What a moved window boots from.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", content = "json", rename_all = "camelCase")]
pub enum HeldTabs {
    /// The tabs and chats it was opened with, until it holds its own.
    Transfer(String),
    /// The tabs it last held. Their chats are in the session store.
    Tabs(String),
}

#[derive(Default)]
struct Slots {
    /// A payload waiting for the window about to open.
    staged: Option<(String, Instant)>,
    /// Each moved window's tabs, by label. In memory only: a reload of that
    /// window gets them back, and a quit forgets them.
    held: HashMap<String, HeldTabs>,
}

pub struct WindowTransferState(Mutex<Slots>);

impl WindowTransferState {
    pub fn new() -> Self {
        Self(Mutex::new(Slots::default()))
    }

    /// Give the staged payload to the moved window `label` before it opens.
    pub fn bind(&self, label: &str) -> Result<(), String> {
        let mut slots = self.0.lock().map_err(|err| err.to_string())?;
        bind(&mut slots, label, Instant::now())
    }

    /// Drop what a closed window held.
    pub fn forget(&self, label: &str) {
        if let Ok(mut slots) = self.0.lock() {
            slots.held.remove(label);
        }
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

/// Only a moved window takes a staged payload, and only as it is opened, so a
/// reload of any window cannot take tabs meant for another.
fn bind(slots: &mut Slots, label: &str, now: Instant) -> Result<(), String> {
    if !is_moved_window(label) {
        return Err("only a moved window takes moved tabs".into());
    }
    let payload = take_fresh(&mut slots.staged, now).ok_or("The tab to move is gone.")?;
    slots
        .held
        .insert(label.to_string(), HeldTabs::Transfer(payload));
    Ok(())
}

/// The main window and every other window get nothing: they boot the main
/// workspace. A moved window gets only its own tabs.
fn held_for(slots: &Slots, label: &str) -> Option<HeldTabs> {
    if !is_moved_window(label) {
        return None;
    }
    slots.held.get(label).cloned()
}

fn hold(slots: &mut Slots, label: &str, tabs: String) -> Result<(), String> {
    if !is_moved_window(label) {
        return Err("only a moved window holds its own tabs".into());
    }
    if tabs.trim().is_empty() {
        return Err("empty window tabs".into());
    }
    if tabs.len() > MAX_TABS_BYTES {
        return Err("window tabs are too large".into());
    }
    slots.held.insert(label.to_string(), HeldTabs::Tabs(tabs));
    Ok(())
}

#[tauri::command]
pub fn stage_window_transfer(
    state: State<'_, WindowTransferState>,
    payload: String,
) -> Result<(), String> {
    check_payload(&payload)?;
    state.0.lock().map_err(|err| err.to_string())?.staged = Some((payload, Instant::now()));
    Ok(())
}

/// The tabs this window boots from, read on every boot, reloads included.
#[tauri::command]
pub fn load_window_tabs(
    window: WebviewWindow,
    state: State<'_, WindowTransferState>,
) -> Result<Option<HeldTabs>, String> {
    let slots = state.0.lock().map_err(|err| err.to_string())?;
    Ok(held_for(&slots, window.label()))
}

/// Keep a moved window's tabs for its next reload.
#[tauri::command]
pub fn hold_window_tabs(
    window: WebviewWindow,
    state: State<'_, WindowTransferState>,
    tabs: String,
) -> Result<(), String> {
    let mut slots = state.0.lock().map_err(|err| err.to_string())?;
    hold(&mut slots, window.label(), tabs)
}

/// Drop a staged payload nobody took. The source window calls this when the
/// new window fails to open, so a window opened later cannot take tabs that
/// stayed where they were.
#[tauri::command]
pub fn clear_window_transfer(state: State<'_, WindowTransferState>) -> Result<(), String> {
    clear(&mut state.0.lock().map_err(|err| err.to_string())?.staged);
    Ok(())
}

fn clear(slot: &mut Option<(String, Instant)>) {
    *slot = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn staged(payload: &str, now: Instant) -> Slots {
        Slots {
            staged: Some((payload.to_string(), now)),
            ..Slots::default()
        }
    }

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

    #[test]
    fn a_cleared_payload_is_never_taken() {
        let now = Instant::now();
        let mut slot = Some(("{}".to_string(), now));
        clear(&mut slot);
        assert_eq!(take_fresh(&mut slot, now), None);
        let mut empty = None;
        clear(&mut empty);
        assert!(empty.is_none());
    }

    #[test]
    fn only_moved_labels_count_as_moved_windows() {
        assert!(is_moved_window("moved-3"));
        assert!(!is_moved_window("main"));
        assert!(!is_moved_window("window-3"));
        assert!(!is_moved_window("quick-session-1"));
        assert!(!is_moved_window("mono-chat-first"));
    }

    #[test]
    fn a_moved_window_reloads_with_the_tabs_it_was_given() {
        let now = Instant::now();
        let mut slots = staged(r#"{"tabs":["a"]}"#, now);
        bind(&mut slots, "moved-2", now).unwrap();
        assert!(slots.staged.is_none());
        let first = held_for(&slots, "moved-2");
        assert_eq!(first, Some(HeldTabs::Transfer(r#"{"tabs":["a"]}"#.into())));
        // A reload reads again and gets the same tabs.
        assert_eq!(held_for(&slots, "moved-2"), first);
    }

    #[test]
    fn a_moved_window_reloads_with_the_tabs_it_last_held() {
        let now = Instant::now();
        let mut slots = staged(r#"{"tabs":["a"]}"#, now);
        bind(&mut slots, "moved-2", now).unwrap();
        hold(&mut slots, "moved-2", r#"{"tabs":["a","b"]}"#.into()).unwrap();
        assert_eq!(
            held_for(&slots, "moved-2"),
            Some(HeldTabs::Tabs(r#"{"tabs":["a","b"]}"#.into()))
        );
    }

    #[test]
    fn the_main_window_never_takes_or_holds_moved_tabs() {
        let now = Instant::now();
        let mut slots = staged(r#"{"tabs":["a"]}"#, now);
        assert!(bind(&mut slots, "main", now).is_err());
        assert!(bind(&mut slots, "window-4", now).is_err());
        // The payload stays for the moved window it was staged for.
        assert!(slots.staged.is_some());
        assert!(hold(&mut slots, "main", r#"{"tabs":["b"]}"#.into()).is_err());
        assert_eq!(held_for(&slots, "main"), None);
        assert_eq!(held_for(&slots, "window-4"), None);
        bind(&mut slots, "moved-5", now).unwrap();
        assert_eq!(held_for(&slots, "main"), None);
    }

    #[test]
    fn two_moved_windows_each_keep_their_own_tabs() {
        let now = Instant::now();
        let mut slots = staged(r#"{"tabs":["a"]}"#, now);
        bind(&mut slots, "moved-2", now).unwrap();
        slots.staged = Some((r#"{"tabs":["b"]}"#.into(), now));
        bind(&mut slots, "moved-3", now).unwrap();
        hold(&mut slots, "moved-3", r#"{"tabs":["b2"]}"#.into()).unwrap();
        assert_eq!(
            held_for(&slots, "moved-2"),
            Some(HeldTabs::Transfer(r#"{"tabs":["a"]}"#.into()))
        );
        assert_eq!(
            held_for(&slots, "moved-3"),
            Some(HeldTabs::Tabs(r#"{"tabs":["b2"]}"#.into()))
        );
    }

    #[test]
    fn a_moved_window_with_nothing_held_gets_nothing() {
        let slots = Slots::default();
        // After an app restart, or once the window was forgotten.
        assert_eq!(held_for(&slots, "moved-7"), None);
    }

    #[test]
    fn opening_a_moved_window_with_nothing_staged_fails() {
        let now = Instant::now();
        let mut slots = Slots::default();
        assert!(bind(&mut slots, "moved-2", now).is_err());
        let mut stale = staged("{}", now);
        assert!(bind(
            &mut stale,
            "moved-2",
            now + PAYLOAD_TTL + Duration::from_secs(1)
        )
        .is_err());
        assert_eq!(held_for(&stale, "moved-2"), None);
    }

    #[test]
    fn a_closed_window_is_forgotten() {
        let state = WindowTransferState::new();
        state.0.lock().unwrap().staged = Some(("{}".into(), Instant::now()));
        state.bind("moved-2").unwrap();
        state.forget("moved-2");
        assert_eq!(held_for(&state.0.lock().unwrap(), "moved-2"), None);
    }

    #[test]
    fn refuses_empty_and_oversized_tabs() {
        let mut slots = Slots::default();
        assert!(hold(&mut slots, "moved-2", " ".into()).is_err());
        assert!(hold(&mut slots, "moved-2", "x".repeat(MAX_TABS_BYTES + 1)).is_err());
        assert_eq!(held_for(&slots, "moved-2"), None);
    }

    #[test]
    fn held_tabs_reach_the_page_as_kind_and_json() {
        let value = serde_json::to_value(HeldTabs::Tabs("{}".into())).unwrap();
        assert_eq!(value, serde_json::json!({ "kind": "tabs", "json": "{}" }));
        let value = serde_json::to_value(HeldTabs::Transfer("{}".into())).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "kind": "transfer", "json": "{}" })
        );
    }
}
