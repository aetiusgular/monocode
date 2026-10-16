//! Wave 3 contract: the activity log's write side. Lane B fills these; the
//! stubs drop their input. Lane A (telemetry) and lane C (computer use) call
//! them and must not depend on anything being kept.
//!
//! None of them returns an error or panics: a log that cannot be written must
//! not stop a turn or a spawn.

// The stubs have no caller until the lanes add one. Lane B removes this.
#![allow(dead_code)]

pub mod types;

pub use types::{ActivityEvent, ApprovalRecord, ProcessKind};

/// Adds one event to the log.
pub fn record(event: ActivityEvent) {
    let _ = event;
}

/// Adds what one approval card, rule or grant allowed.
pub fn record_approval(record: ApprovalRecord) {
    let _ = record;
}

/// Tells the collector which chat a process belongs to, so it can follow the
/// process and its descendants.
pub fn register_process(pid: u32, chat_id: &str, kind: ProcessKind) {
    let _ = (pid, chat_id, kind);
}
