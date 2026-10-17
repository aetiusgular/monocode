//! B5: the check. Each logged action is set against the approval that
//! covered it at that time; an action nothing covered is a flag.
//!
//! The pattern is Fenceline's (note X, section 3.1): what the agent was
//! allowed (here, MonoCode's own approvals record, which the agent cannot
//! write) against what the OS saw. Detection only: a flag is shown, nothing
//! is blocked.
//!
//! Flags:
//! - `appNotGranted`: computer use acted in an app no grant covered then.
//! - `writeOutsideFolders`: a file created, written, renamed or deleted
//!   outside the chat's folders, and outside any folder approval.
//! - `leftRunning`: a process a tool call started that was still running
//!   when the call ended (Fenceline: `cmd &` and `nohup` slip past monitors).
//! - `sensitivePath`: a sensitive file opened (the collector keeps only
//!   those opens).
//! - `newHost`: a host never seen before and not approved.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::types::{ActivityEvent, ActivitySource, ApprovalRecord, ApprovalScope, ApprovalSubject};

/// A "once" approval covers its action, which follows within this window.
pub const ONCE_WINDOW_MS: i64 = 10 * 60 * 1000;
/// A process still running this long after its tool call ended is flagged.
pub const LEFT_RUNNING_GRACE_MS: i64 = 10_000;
/// Events shown around a flag.
pub const CONTEXT_WINDOW_MS: i64 = 30_000;
pub const MAX_CONTEXT: usize = 20;
/// A screenshot taken this close to the flagged action is shown with it.
pub const SCREENSHOT_WINDOW_MS: i64 = 10_000;

/// What the check knows about a chat.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatContext {
    pub chat_id: String,
    pub harness: String,
    /// Absolute folders the chat may write in: its working folder first.
    pub folders: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlagReason {
    AppNotGranted,
    WriteOutsideFolders,
    LeftRunning,
    SensitivePath,
    NewHost,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Flag {
    /// The flagged event's id, prefixed with the reason.
    pub id: String,
    pub chat_id: String,
    pub at: i64,
    pub reason: FlagReason,
    /// One line, plain text.
    pub summary: String,
    pub event_id: String,
    /// Ids of the events around it, same chat, oldest first.
    pub context: Vec<String>,
    /// A screenshot path from computer use's record near the action.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<String>,
}

pub struct CheckInput<'a> {
    pub events: &'a [ActivityEvent],
    pub approvals: &'a [ApprovalRecord],
    pub chats: &'a HashMap<String, ChatContext>,
    /// Hosts seen before this window, lowercased.
    pub known_hosts: &'a HashSet<String>,
    /// The time of the check, for "still running".
    pub now_ms: i64,
}

fn str_field<'a>(event: &'a ActivityEvent, key: &str) -> Option<&'a str> {
    event.detail.get(key).and_then(Value::as_str)
}

/// Whether an approval held at `at`.
pub fn holds_at(record: &ApprovalRecord, at: i64) -> bool {
    if !record.granted || at < record.granted_at {
        return false;
    }
    let end = match (record.ended_at, record.scope) {
        (Some(end), _) => end,
        (None, ApprovalScope::Once) => record.granted_at.saturating_add(ONCE_WINDOW_MS),
        (None, _) => i64::MAX,
    };
    at <= end
}

fn covering<'a>(
    approvals: &'a [ApprovalRecord],
    chat_id: &str,
    subject: ApprovalSubject,
    at: i64,
    matches: impl Fn(&str) -> bool,
) -> Option<&'a ApprovalRecord> {
    approvals.iter().find(|record| {
        // A project's site rule is kept per folder, not per chat, so it is
        // recorded with no chat and covers a host in every chat.
        let chat_matches = record.chat_id == chat_id
            || (subject == ApprovalSubject::Host && record.chat_id.is_empty());
        record.subject == subject && chat_matches && holds_at(record, at) && matches(&record.target)
    })
}

/// True when `path` is the folder or below it, read literally.
pub fn inside(path: &str, folder: &str) -> bool {
    let folder = folder.trim_end_matches('/');
    if folder.is_empty() || !path.starts_with('/') || path.split('/').any(|p| p == "..") {
        return false;
    }
    path == folder || path.starts_with(&format!("{folder}/"))
}

/// The user's home folder from a path, `/Users/<name>` or `/home/<name>`.
fn home_of(path: &str) -> Option<String> {
    let mut parts = path.split('/');
    let (Some(""), Some(root), Some(name)) = (parts.next(), parts.next(), parts.next()) else {
        return None;
    };
    ((root == "Users" || root == "home") && !name.is_empty()).then(|| format!("/{root}/{name}"))
}

/// Paths a write never flags: scratch space, devices, and the harnesses' own
/// state (Fenceline's filter for Claude Code's `~/.claude`).
/// The activity log's and computer use's folders in MonoCode's data folder.
/// Compared without case: APFS is case-insensitive, so `Activity/` is the
/// same folder (security review T2).
fn guarded_path(path: &str) -> bool {
    let Some(home) = home_of(path) else {
        return false;
    };
    const GUARDED: &[&str] = &["activity", "computer-use"];
    let lower = path.to_ascii_lowercase();
    GUARDED.iter().any(|sub| {
        inside(
            &lower,
            &format!("{home}/Library/Application Support/com.monocode.desktop/{sub}")
                .to_ascii_lowercase(),
        )
    })
}

pub fn noise_path(path: &str, granted_app: bool) -> bool {
    const SYSTEM: &[&str] = &[
        "/tmp",
        "/private/tmp",
        "/var/folders",
        "/private/var/folders",
        "/dev",
    ];
    if SYSTEM.iter().any(|prefix| inside(path, prefix)) {
        return true;
    }
    let Some(home) = home_of(path) else {
        return false;
    };
    // The log itself, its install staging and computer use's recordings sit
    // in MonoCode's data folder. A chat's process writing there is the
    // tampering the log exists to catch (security review S5). The app's own
    // writes are never attributed to a chat, so they raise nothing.
    if guarded_path(path) {
        return false;
    }
    const HARNESS: &[&str] = &[
        ".claude",
        ".codex",
        ".cache",
        ".npm",
        ".cargo/registry",
        "Library/Caches",
        "Library/Logs",
        "Library/Application Support/com.monocode.desktop",
    ];
    if HARNESS
        .iter()
        .any(|rel| inside(path, &format!("{home}/{rel}")))
    {
        return true;
    }
    if path.starts_with(&format!("{home}/.claude.json")) {
        return true;
    }
    // An app working under a grant writes its own state; that is the app,
    // not something the agent chose to touch.
    const APP_STATE: &[&str] = &[
        "Library/Containers",
        "Library/Preferences",
        "Library/Saved Application State",
        "Library/Group Containers",
        "Library/HTTPStorages",
        "Library/WebKit",
    ];
    granted_app
        && APP_STATE
            .iter()
            .any(|rel| inside(path, &format!("{home}/{rel}")))
}

/// A project's own `.env` inside the chat's folders is expected reading.
fn expected_sensitive(path: &str, folders: &[String]) -> bool {
    let name = path.rsplit('/').next().unwrap_or("");
    let env_file = name == ".env" || name.starts_with(".env.");
    env_file && folders.iter().any(|f| inside(path, f))
}

fn host_matches(target: &str, host: &str) -> bool {
    let target = target.trim().to_ascii_lowercase();
    let host = host.to_ascii_lowercase();
    if let Some(suffix) = target.strip_prefix("*.") {
        return host == suffix || host.ends_with(&format!(".{suffix}"));
    }
    target == host
}

/// The host an event reached: its own `host`, or the one its OTel detail
/// named (`detail.otel.host`, lane A's feed keeps it there).
pub fn event_host(event: &ActivityEvent) -> Option<&str> {
    str_field(event, "host").or_else(|| {
        event
            .detail
            .get("otel")
            .and_then(|otel| otel.get("host"))
            .and_then(Value::as_str)
    })
}

/// Whether a path is inside computer use's recording folder under its home,
/// with no `..` (review U6).
fn in_recordings(path: &str) -> bool {
    let Some(home) = home_of(path) else {
        return false;
    };
    !path.split('/').any(|part| part == "..")
        && inside(
            &path.to_ascii_lowercase(),
            &format!(
                "{home}/Library/Application Support/com.monocode.desktop/computer-use/recordings"
            )
            .to_ascii_lowercase(),
        )
}

/// One computer-use runtime: its pid and the time span it ran.
struct RuntimeSpan {
    pid: u32,
    started: i64,
    ended: Option<i64>,
}

/// The computer-use runtimes each chat ran. A runtime ends at the first of:
/// its own stop record, the chat's next runtime start, or the first exit of
/// its pid after its start. A write counts as the runtime's only inside
/// that span, so a reused pid is not exempted (reviews U5, V2, V3).
fn runtime_spans(events: &[ActivityEvent]) -> HashMap<String, Vec<RuntimeSpan>> {
    let mut starts: HashMap<String, Vec<(i64, u32)>> = HashMap::new();
    let mut stops: HashMap<(String, u32), Vec<i64>> = HashMap::new();
    let mut exits: HashMap<u32, Vec<i64>> = HashMap::new();
    for e in events {
        let Some(pid) = e.pid else { continue };
        match (&e.source, e.kind.as_str()) {
            (ActivitySource::Cua, "cua.runtime") => starts
                .entry(e.chat_id.clone())
                .or_default()
                .push((e.at, pid)),
            (ActivitySource::Cua, "cua.runtime.stop") => stops
                .entry((e.chat_id.clone(), pid))
                .or_default()
                .push(e.at),
            (ActivitySource::Eslogger, "exit") => exits.entry(pid).or_default().push(e.at),
            _ => {}
        }
    }
    let first_from = |list: Option<&Vec<i64>>, from: i64| {
        list.and_then(|times| times.iter().copied().filter(|&t| t >= from).min())
    };
    let mut spans = HashMap::new();
    for (chat, mut list) in starts {
        list.sort();
        list.dedup();
        let mut out = Vec::new();
        for (i, &(started, pid)) in list.iter().enumerate() {
            let next = list.get(i + 1).map(|&(at, _)| at);
            let stop = first_from(stops.get(&(chat.clone(), pid)), started);
            let exit = first_from(exits.get(&pid), started);
            let ended = [next, stop, exit].into_iter().flatten().min();
            out.push(RuntimeSpan {
                pid,
                started,
                ended,
            });
        }
        spans.insert(chat, out);
    }
    spans
}

/// Tool call windows per chat: call id to (start, end).
fn tool_windows(events: &[ActivityEvent]) -> HashMap<(String, String), (i64, i64)> {
    let mut windows: HashMap<(String, String), (i64, i64)> = HashMap::new();
    for event in events {
        if !matches!(event.source, ActivitySource::Adapter | ActivitySource::Otel) {
            continue;
        }
        if !event.kind.starts_with("tool.") {
            continue;
        }
        let Some(call) = str_field(event, "callId") else {
            continue;
        };
        let window = windows
            .entry((event.chat_id.clone(), call.to_string()))
            .or_insert((event.at, event.at));
        window.0 = window.0.min(event.at);
        window.1 = window.1.max(event.at);
    }
    windows
}

/// Runs the check. Flags come back oldest first.
pub fn run(input: &CheckInput) -> Vec<Flag> {
    let empty_folders: Vec<String> = Vec::new();
    let mut flags: Vec<Flag> = Vec::new();
    let mut flagged_hosts: HashSet<(String, String)> = HashSet::new();

    // Exits, by pid, for "left running".
    let mut exits: HashMap<u32, i64> = HashMap::new();
    for event in input.events {
        if event.source == ActivitySource::Eslogger && event.kind == "exit" {
            if let Some(pid) = event.pid {
                exits
                    .entry(pid)
                    .and_modify(|t| *t = (*t).max(event.at))
                    .or_insert(event.at);
            }
        }
    }
    let windows = tool_windows(input.events);
    let runtimes = runtime_spans(input.events);

    for event in input.events {
        if event.chat_id.is_empty() {
            continue;
        }
        let folders = input
            .chats
            .get(&event.chat_id)
            .map(|chat| &chat.folders)
            .unwrap_or(&empty_folders);
        let mut found: Option<(FlagReason, String)> = None;

        // An app no grant covered.
        let bundle = str_field(event, "bundleId").or_else(|| str_field(event, "grant"));
        if matches!(event.source, ActivitySource::Cua | ActivitySource::Eslogger) {
            if let Some(bundle) = bundle {
                let covered = covering(
                    input.approvals,
                    &event.chat_id,
                    ApprovalSubject::App,
                    event.at,
                    |t| t == bundle,
                );
                if covered.is_none() {
                    found = Some((
                        FlagReason::AppNotGranted,
                        format!("Acted in {bundle} with no grant for this chat"),
                    ));
                }
            }
        }

        // Writes outside the chat's folders.
        if found.is_none()
            && event.source == ActivitySource::Eslogger
            && matches!(
                event.kind.as_str(),
                "create" | "write" | "rename" | "unlink"
            )
        {
            let granted_app = str_field(event, "grant").is_some();
            let paths = [str_field(event, "path"), str_field(event, "dest")];
            let own_runtime = event.pid.is_some_and(|pid| {
                runtimes.get(&event.chat_id).is_some_and(|spans| {
                    spans.iter().any(|span| {
                        span.pid == pid
                            && event.at >= span.started
                            && span.ended.is_none_or(|ended| event.at <= ended)
                    })
                })
            });
            for path in paths.into_iter().flatten() {
                // The chat's own runtime writing its recording (T1).
                if own_runtime && in_recordings(path) {
                    continue;
                }
                // The log's and the recordings' folders are flagged even when
                // a chat's folder holds them, such as a chat on ~ (review U9).
                let guarded = guarded_path(path);
                if !guarded
                    && (noise_path(path, granted_app) || folders.iter().any(|f| inside(path, f)))
                {
                    continue;
                }
                // A folder approval does not clear a guarded path either, as
                // with a chat's folder (review V6).
                let approved = !guarded
                    && covering(
                        input.approvals,
                        &event.chat_id,
                        ApprovalSubject::Folder,
                        event.at,
                        |t| inside(path, t),
                    )
                    .is_some();
                if !approved {
                    let verb = match event.kind.as_str() {
                        "create" => "Created",
                        "write" => "Wrote",
                        "rename" => "Moved",
                        _ => "Deleted",
                    };
                    found = Some((
                        FlagReason::WriteOutsideFolders,
                        format!("{verb} {path}, outside this chat's folders"),
                    ));
                    break;
                }
            }
        }

        // Sensitive opens.
        if found.is_none() && event.source == ActivitySource::Eslogger && event.kind == "open" {
            if let Some(path) = str_field(event, "path") {
                if !expected_sensitive(path, folders) {
                    found = Some((FlagReason::SensitivePath, format!("Opened {path}")));
                }
            }
        }

        // New hosts.
        if found.is_none() {
            if let Some(host) = event_host(event) {
                let lower = host.to_ascii_lowercase();
                let approved = covering(
                    input.approvals,
                    &event.chat_id,
                    ApprovalSubject::Host,
                    event.at,
                    |t| host_matches(t, &lower),
                );
                let key = (event.chat_id.clone(), lower.clone());
                if approved.is_none()
                    && !input.known_hosts.contains(&lower)
                    && !flagged_hosts.contains(&key)
                {
                    flagged_hosts.insert(key);
                    found = Some((
                        FlagReason::NewHost,
                        format!("Reached {lower}, a host not seen before"),
                    ));
                }
            }
        }

        // Processes a tool call left running.
        if found.is_none()
            && event.source == ActivitySource::Eslogger
            && matches!(event.kind.as_str(), "fork" | "exec")
        {
            if let Some(pid) = event.pid {
                let started_in = windows.iter().find(|((chat, _), (start, end))| {
                    *chat == event.chat_id && event.at >= *start && event.at <= *end
                });
                if let Some((_, (_, end))) = started_in {
                    let deadline = end.saturating_add(LEFT_RUNNING_GRACE_MS);
                    let exited_in_time = exits.get(&pid).is_some_and(|t| *t <= deadline);
                    let call_over = input.now_ms > deadline;
                    let is_exec_of_a_fork = event.kind == "exec"
                        && input.events.iter().any(|e| {
                            e.pid == Some(pid)
                                && e.kind == "fork"
                                && e.at <= event.at
                                && e.chat_id == event.chat_id
                        });
                    if call_over && !exited_in_time && !is_exec_of_a_fork {
                        let what = str_field(event, "exe").unwrap_or("a process");
                        found = Some((
                            FlagReason::LeftRunning,
                            format!("{what} (pid {pid}) kept running after its tool call ended"),
                        ));
                    }
                }
            }
        }

        if let Some((reason, summary)) = found {
            flags.push(Flag {
                id: format!("{}:{}", reason_key(reason), event.id),
                chat_id: event.chat_id.clone(),
                at: event.at,
                reason,
                summary,
                event_id: event.id.clone(),
                context: context_ids(input.events, event),
                screenshot: screenshot_near(input.events, event),
            });
        }
    }
    flags.sort_by_key(|flag| flag.at);
    flags
}

pub fn reason_key(reason: FlagReason) -> &'static str {
    match reason {
        FlagReason::AppNotGranted => "appNotGranted",
        FlagReason::WriteOutsideFolders => "writeOutsideFolders",
        FlagReason::LeftRunning => "leftRunning",
        FlagReason::SensitivePath => "sensitivePath",
        FlagReason::NewHost => "newHost",
    }
}

fn context_ids(events: &[ActivityEvent], center: &ActivityEvent) -> Vec<String> {
    let mut near: Vec<&ActivityEvent> = events
        .iter()
        .filter(|e| e.chat_id == center.chat_id && (e.at - center.at).abs() <= CONTEXT_WINDOW_MS)
        .collect();
    near.sort_by_key(|e| ((e.at - center.at).abs(), e.at));
    near.truncate(MAX_CONTEXT);
    near.sort_by_key(|e| e.at);
    near.into_iter().map(|e| e.id.clone()).collect()
}

fn screenshot_near(events: &[ActivityEvent], center: &ActivityEvent) -> Option<String> {
    events
        .iter()
        .filter(|e| e.chat_id == center.chat_id && (e.at - center.at).abs() <= SCREENSHOT_WINDOW_MS)
        .filter_map(|e| str_field(e, "screenshot").map(|s| ((e.at - center.at).abs(), s)))
        .min_by_key(|(distance, _)| *distance)
        .map(|(_, path)| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(
        id: &str,
        at: i64,
        source: ActivitySource,
        kind: &str,
        detail: Value,
        pid: Option<u32>,
    ) -> ActivityEvent {
        ActivityEvent {
            id: id.into(),
            at,
            chat_id: "c1".into(),
            harness: "claude".into(),
            source,
            kind: kind.into(),
            summary: String::new(),
            detail,
            pid,
            approval_id: None,
        }
    }

    fn approval(
        subject: ApprovalSubject,
        target: &str,
        scope: ApprovalScope,
        at: i64,
        end: Option<i64>,
    ) -> ApprovalRecord {
        ApprovalRecord {
            id: format!("a-{target}"),
            chat_id: "c1".into(),
            harness: "claude".into(),
            subject,
            target: target.into(),
            scope,
            granted: true,
            granted_at: at,
            ended_at: end,
        }
    }

    fn chats() -> HashMap<String, ChatContext> {
        HashMap::from([(
            "c1".to_string(),
            ChatContext {
                chat_id: "c1".into(),
                harness: "claude".into(),
                folders: vec!["/Users/t/code/app".into(), "/Users/t/code/my lib".into()],
            },
        )])
    }

    fn check(events: &[ActivityEvent], approvals: &[ApprovalRecord]) -> Vec<Flag> {
        let chats = chats();
        let hosts = HashSet::from(["github.com".to_string()]);
        run(&CheckInput {
            events,
            approvals,
            chats: &chats,
            known_hosts: &hosts,
            now_ms: 1_000_000,
        })
    }

    fn es(id: &str, at: i64, kind: &str, path: &str) -> ActivityEvent {
        ev(
            id,
            at,
            ActivitySource::Eslogger,
            kind,
            json!({ "path": path }),
            Some(10),
        )
    }

    #[test]
    fn writes_inside_the_folders_pass_and_outside_flag() {
        let flags = check(
            &[
                es("1", 1, "write", "/Users/t/code/app/src/main.rs"),
                es("2", 2, "create", "/Users/t/code/my lib/new file.txt"),
                es("3", 3, "unlink", "/Users/t/Documents/taxes.pdf"),
                es("4", 4, "write", "/Users/t/code/application/x"),
            ],
            &[],
        );
        let ids: Vec<&str> = flags.iter().map(|f| f.event_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["3", "4"],
            "a sibling folder with a shared prefix is outside"
        );
        assert_eq!(flags[0].reason, FlagReason::WriteOutsideFolders);
        assert!(flags[0]
            .summary
            .starts_with("Deleted /Users/t/Documents/taxes.pdf"));
    }

    #[test]
    fn a_rename_out_of_the_folder_flags_on_its_destination() {
        let mut event = es("1", 1, "rename", "/Users/t/code/app/secret.txt");
        event.detail["dest"] = json!("/Users/t/Desktop/secret.txt");
        let flags = check(&[event], &[]);
        assert_eq!(flags.len(), 1);
        assert!(flags[0].summary.contains("/Users/t/Desktop/secret.txt"));
    }

    #[test]
    fn dot_dot_never_counts_as_inside() {
        let flags = check(
            &[es("1", 1, "write", "/Users/t/code/app/../../.zshrc")],
            &[],
        );
        assert_eq!(flags.len(), 1);
    }

    #[test]
    fn a_write_to_the_log_or_the_recordings_is_flagged() {
        // Security review S5.
        let base = "/Users/t/Library/Application Support/com.monocode.desktop";
        let flags = check(
            &[
                es(
                    "1",
                    1,
                    "write",
                    &format!("{base}/activity/app-2026-10-16.jsonl"),
                ),
                es(
                    "2",
                    2,
                    "create",
                    &format!("{base}/activity/install/c.plist"),
                ),
                es(
                    "3",
                    3,
                    "unlink",
                    &format!("{base}/computer-use/recordings/r/turn-00001/after.png"),
                ),
                es("4", 4, "write", &format!("{base}/monocode.db")),
            ],
            &[],
        );
        let ids: Vec<&str> = flags.iter().map(|f| f.event_id.as_str()).collect();
        assert_eq!(ids, vec!["1", "2", "3"]);
    }

    #[test]
    fn the_chats_runtime_may_write_its_recordings_and_nothing_else_may() {
        // Security review T1 and T2.
        let base = "/Users/t/Library/Application Support/com.monocode.desktop";
        let rec = format!("{base}/computer-use/recordings/rt1/turn-00001/after.png");
        let mut runtime = ev(
            "r",
            0,
            ActivitySource::Cua,
            "cua.runtime",
            json!({}),
            Some(77),
        );
        runtime.chat_id = "c1".into();
        let mut by_runtime = es("1", 1, "create", &rec);
        by_runtime.pid = Some(77);
        let by_other = es("2", 2, "create", &rec); // pid 10, the harness
        let mut other_chat_runtime = es("3", 3, "create", &rec);
        other_chat_runtime.pid = Some(77);
        other_chat_runtime.chat_id = "c2".into();
        let mut runtime_elsewhere = es("4", 4, "write", &format!("{base}/activity/app-x.jsonl"));
        runtime_elsewhere.pid = Some(77);
        let case = es("5", 5, "write", &format!("{base}/Activity/app-x.jsonl"));
        let flags = check(
            &[
                runtime,
                by_runtime,
                by_other,
                other_chat_runtime,
                runtime_elsewhere,
                case,
            ],
            &[],
        );
        let ids: Vec<&str> = flags.iter().map(|f| f.event_id.as_str()).collect();
        assert_eq!(ids, vec!["2", "3", "4", "5"]);
    }

    #[test]
    fn the_runtime_exemption_is_bounded_in_time_and_place() {
        // Reviews U5, U6 and U9.
        let base = "/Users/t/Library/Application Support/com.monocode.desktop";
        let rec = format!("{base}/computer-use/recordings/rt1/turn-00001/after.png");
        let mut runtime = ev(
            "r",
            100,
            ActivitySource::Cua,
            "cua.runtime",
            json!({}),
            Some(77),
        );
        runtime.chat_id = "c1".into();
        let mut before = es("1", 50, "create", &rec);
        before.pid = Some(77);
        let mut during = es("2", 150, "create", &rec);
        during.pid = Some(77);
        let mut exit = ev(
            "x",
            200,
            ActivitySource::Eslogger,
            "exit",
            json!({}),
            Some(77),
        );
        exit.chat_id = "c1".into();
        let mut reused = es("3", 300, "create", &rec);
        reused.pid = Some(77);
        let mut dotdot = es(
            "4",
            160,
            "write",
            &format!("{base}/computer-use/recordings/../../activity/app-x.jsonl"),
        );
        dotdot.pid = Some(77);
        let flags = check(&[runtime, before, during, exit, reused, dotdot], &[]);
        let ids: Vec<&str> = flags.iter().map(|f| f.event_id.as_str()).collect();
        assert_eq!(ids, vec!["1", "4", "3"]);
    }

    #[test]
    fn a_runtime_ends_at_its_first_exit_its_stop_or_the_next_start() {
        // Review V2 and V3.
        let base = "/Users/t/Library/Application Support/com.monocode.desktop";
        let rec = format!("{base}/computer-use/recordings/rt1/turn-00001/after.png");
        let cua = |id: &str, at: i64, kind: &str, pid: u32| {
            let mut e = ev(id, at, ActivitySource::Cua, kind, json!({}), Some(pid));
            e.chat_id = "c1".into();
            e
        };
        let exit = |id: &str, at: i64, pid: u32| {
            let mut e = ev(
                id,
                at,
                ActivitySource::Eslogger,
                "exit",
                json!({}),
                Some(pid),
            );
            e.chat_id = "c1".into();
            e
        };
        let write = |id: &str, at: i64, pid: u32| {
            let mut e = es(id, at, "create", &rec);
            e.pid = Some(pid);
            e
        };
        let flags = check(
            &[
                // pid 77: exits at 200; a later process reusing 77 exits at 500.
                cua("r1", 100, "cua.runtime", 77),
                write("1", 150, 77),
                exit("x1", 200, 77),
                write("2", 300, 77),
                exit("x2", 500, 77),
                // pid 88: its stop record ends it, with no exit in view.
                cua("r2", 600, "cua.runtime", 88),
                write("3", 650, 88),
                cua("s2", 700, "cua.runtime.stop", 88),
                write("4", 750, 88),
                // pid 99: the chat's next runtime start ends it.
                cua("r3", 800, "cua.runtime", 99),
                write("5", 850, 99),
                cua("r4", 900, "cua.runtime", 66),
                write("6", 950, 99),
                write("7", 960, 66),
            ],
            &[],
        );
        let ids: Vec<&str> = flags.iter().map(|f| f.event_id.as_str()).collect();
        assert_eq!(ids, vec!["2", "4", "6"]);
    }

    #[test]
    fn a_folder_approval_does_not_clear_the_log_or_the_recordings() {
        // Review V6.
        let approvals = [approval(
            ApprovalSubject::Folder,
            "/Users/t",
            ApprovalScope::Chat,
            0,
            None,
        )];
        let base = "/Users/t/Library/Application Support/com.monocode.desktop";
        let flags = check(
            &[
                es("1", 5, "write", &format!("{base}/activity/app-x.jsonl")),
                es("2", 6, "write", "/Users/t/Documents/a.txt"),
            ],
            &approvals,
        );
        let ids: Vec<&str> = flags.iter().map(|f| f.event_id.as_str()).collect();
        assert_eq!(ids, vec!["1"]);
    }

    #[test]
    fn noise_paths_never_flag() {
        let flags = check(
            &[
                es("1", 1, "write", "/private/var/folders/xy/T/tmp.1"),
                es("2", 2, "write", "/Users/t/.claude/projects/x.jsonl"),
                es("3", 3, "write", "/Users/t/.claude.json.backup"),
                es("4", 4, "create", "/dev/null"),
                es("5", 5, "write", "/Users/t/.codex/sessions/a"),
            ],
            &[],
        );
        assert!(flags.is_empty(), "{flags:?}");
    }

    #[test]
    fn a_folder_approval_covers_a_write_while_it_holds() {
        let approvals = [approval(
            ApprovalSubject::Folder,
            "/Users/t/Documents",
            ApprovalScope::Chat,
            0,
            Some(100),
        )];
        let flags = check(
            &[
                es("1", 50, "write", "/Users/t/Documents/a.txt"),
                es("2", 150, "write", "/Users/t/Documents/b.txt"),
            ],
            &approvals,
        );
        assert_eq!(flags.len(), 1);
        assert_eq!(flags[0].event_id, "2");
    }

    #[test]
    fn a_denied_or_other_chat_approval_covers_nothing() {
        let mut denied = approval(
            ApprovalSubject::Folder,
            "/Users/t/Documents",
            ApprovalScope::Chat,
            0,
            None,
        );
        denied.granted = false;
        let mut other = approval(
            ApprovalSubject::Folder,
            "/Users/t/Documents",
            ApprovalScope::Chat,
            0,
            None,
        );
        other.chat_id = "c2".into();
        let flags = check(
            &[es("1", 5, "write", "/Users/t/Documents/a.txt")],
            &[denied, other],
        );
        assert_eq!(flags.len(), 1);
    }

    #[test]
    fn computer_use_in_an_app_with_no_grant_flags() {
        let approvals = [approval(
            ApprovalSubject::App,
            "com.apple.calculator",
            ApprovalScope::Chat,
            0,
            Some(100),
        )];
        let flags = check(
            &[
                ev(
                    "1",
                    10,
                    ActivitySource::Cua,
                    "click",
                    json!({"bundleId": "com.apple.calculator"}),
                    None,
                ),
                ev(
                    "2",
                    20,
                    ActivitySource::Cua,
                    "click",
                    json!({"bundleId": "com.apple.finder"}),
                    None,
                ),
                ev(
                    "3",
                    200,
                    ActivitySource::Cua,
                    "click",
                    json!({"bundleId": "com.apple.calculator"}),
                    None,
                ),
            ],
            &approvals,
        );
        let ids: Vec<&str> = flags.iter().map(|f| f.event_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["2", "3"],
            "a grant that ended covers nothing after"
        );
        assert!(flags.iter().all(|f| f.reason == FlagReason::AppNotGranted));
    }

    #[test]
    fn a_granted_app_writing_its_own_state_is_noise_but_a_document_is_not() {
        let approvals = [approval(
            ApprovalSubject::App,
            "com.apple.finder",
            ApprovalScope::Chat,
            0,
            None,
        )];
        let mut prefs = es(
            "1",
            5,
            "write",
            "/Users/t/Library/Preferences/com.apple.finder.plist",
        );
        prefs.detail["grant"] = json!("com.apple.finder");
        let mut doc = es("2", 6, "unlink", "/Users/t/Documents/report.docx");
        doc.detail["grant"] = json!("com.apple.finder");
        let flags = check(&[prefs, doc], &approvals);
        assert_eq!(flags.len(), 1);
        assert_eq!(flags[0].event_id, "2");
        assert_eq!(flags[0].reason, FlagReason::WriteOutsideFolders);
    }

    #[test]
    fn sensitive_opens_flag_except_the_projects_own_env() {
        let flags = check(
            &[
                es("1", 1, "open", "/Users/t/.ssh/id_ed25519"),
                es("2", 2, "open", "/Users/t/code/app/.env.local"),
                es("3", 3, "open", "/Users/t/other/.env"),
            ],
            &[],
        );
        let ids: Vec<&str> = flags.iter().map(|f| f.event_id.as_str()).collect();
        assert_eq!(ids, vec!["1", "3"]);
        assert!(flags.iter().all(|f| f.reason == FlagReason::SensitivePath));
    }

    #[test]
    fn a_new_host_flags_once_per_chat_unless_approved_or_known() {
        let approvals = [approval(
            ApprovalSubject::Host,
            "*.example.com",
            ApprovalScope::Always,
            0,
            None,
        )];
        let flags = check(
            &[
                ev(
                    "1",
                    1,
                    ActivitySource::Otel,
                    "net",
                    json!({"host": "api.example.com"}),
                    None,
                ),
                ev(
                    "2",
                    2,
                    ActivitySource::Otel,
                    "net",
                    json!({"host": "GitHub.com"}),
                    None,
                ),
                ev(
                    "3",
                    3,
                    ActivitySource::Adapter,
                    "tool.started",
                    json!({"host": "evil.test"}),
                    None,
                ),
                ev(
                    "4",
                    4,
                    ActivitySource::Adapter,
                    "tool.started",
                    json!({"host": "evil.test"}),
                    None,
                ),
                ev(
                    "5",
                    5,
                    ActivitySource::Otel,
                    "net",
                    json!({"host": "example.com.evil.test"}),
                    None,
                ),
            ],
            &approvals,
        );
        let ids: Vec<&str> = flags.iter().map(|f| f.event_id.as_str()).collect();
        assert_eq!(ids, vec!["3", "5"]);
    }

    #[test]
    fn a_host_under_the_otel_detail_flags_too() {
        // Integration: lane A keeps an OTel-derived host at detail.otel.host.
        let flags = check(
            &[ev(
                "1",
                1,
                ActivitySource::Adapter,
                "tool.call",
                json!({"callId": "w1", "otel": {"host": "news.example.org"}}),
                None,
            )],
            &[],
        );
        assert_eq!(flags.len(), 1);
        assert_eq!(flags[0].reason, FlagReason::NewHost);
    }

    #[test]
    fn a_project_host_rule_covers_every_chat_but_a_folder_rule_does_not() {
        let mut host = approval(
            ApprovalSubject::Host,
            "docs.rs",
            ApprovalScope::Always,
            0,
            None,
        );
        host.chat_id = String::new();
        let mut folder = approval(
            ApprovalSubject::Folder,
            "/Users/t/Documents",
            ApprovalScope::Always,
            0,
            None,
        );
        folder.chat_id = String::new();
        let flags = check(
            &[
                ev(
                    "1",
                    1,
                    ActivitySource::Otel,
                    "net",
                    json!({"host": "docs.rs"}),
                    None,
                ),
                es("2", 2, "write", "/Users/t/Documents/a"),
            ],
            &[host, folder],
        );
        let ids: Vec<&str> = flags.iter().map(|f| f.event_id.as_str()).collect();
        assert_eq!(ids, vec!["2"]);
    }

    #[test]
    fn a_once_approval_lapses_after_its_window() {
        let record = approval(ApprovalSubject::Host, "a.dev", ApprovalScope::Once, 0, None);
        assert!(holds_at(&record, ONCE_WINDOW_MS));
        assert!(!holds_at(&record, ONCE_WINDOW_MS + 1));
        assert!(!holds_at(&record, -1));
    }

    #[test]
    fn a_process_left_running_after_its_tool_call_flags() {
        let call = |id: &str, at: i64| {
            ev(
                id,
                at,
                ActivitySource::Adapter,
                "tool.started",
                json!({"callId": "t1"}),
                None,
            )
        };
        let mut daemon = ev(
            "p1",
            110,
            ActivitySource::Eslogger,
            "fork",
            json!({}),
            Some(77),
        );
        daemon.detail["exe"] = json!("/bin/sh");
        let mut done = ev(
            "p2",
            120,
            ActivitySource::Eslogger,
            "fork",
            json!({}),
            Some(78),
        );
        done.detail["exe"] = json!("/usr/bin/git");
        let exit = ev(
            "p3",
            150,
            ActivitySource::Eslogger,
            "exit",
            json!({}),
            Some(78),
        );
        let flags = check(
            &[call("t-start", 100), daemon, done, exit, call("t-end", 200)],
            &[],
        );
        assert_eq!(flags.len(), 1, "{flags:?}");
        assert_eq!(flags[0].reason, FlagReason::LeftRunning);
        assert_eq!(flags[0].event_id, "p1");
    }

    #[test]
    fn a_running_call_is_not_judged_yet() {
        let chats = chats();
        let hosts = HashSet::new();
        let events = [
            ev(
                "t",
                100,
                ActivitySource::Adapter,
                "tool.started",
                json!({"callId": "t1"}),
                None,
            ),
            ev(
                "p",
                110,
                ActivitySource::Eslogger,
                "fork",
                json!({}),
                Some(5),
            ),
        ];
        let flags = run(&CheckInput {
            events: &events,
            approvals: &[],
            chats: &chats,
            known_hosts: &hosts,
            now_ms: 105 + LEFT_RUNNING_GRACE_MS,
        });
        assert!(flags.is_empty());
    }

    #[test]
    fn a_flag_carries_its_context_and_nearest_screenshot() {
        let flags = check(
            &[
                ev(
                    "s1",
                    0,
                    ActivitySource::Cua,
                    "screenshot",
                    json!({"screenshot": "/x/a.png", "bundleId": "com.apple.calculator"}),
                    None,
                ),
                es("w", 5_000, "unlink", "/Users/t/Documents/x"),
                ev(
                    "s2",
                    9_000,
                    ActivitySource::Cua,
                    "screenshot",
                    json!({"screenshot": "/x/b.png"}),
                    None,
                ),
                ev(
                    "far",
                    90_000,
                    ActivitySource::Adapter,
                    "turn",
                    json!({}),
                    None,
                ),
            ],
            &[approval(
                ApprovalSubject::App,
                "com.apple.calculator",
                ApprovalScope::Chat,
                0,
                None,
            )],
        );
        let flag = flags.iter().find(|f| f.event_id == "w").unwrap();
        assert_eq!(flag.screenshot.as_deref(), Some("/x/b.png"));
        assert_eq!(flag.context, vec!["s1", "w", "s2"]);
    }

    #[test]
    fn unattributed_events_are_never_flagged() {
        let mut event = es("1", 1, "unlink", "/etc/hosts");
        event.chat_id = String::new();
        assert!(check(&[event], &[]).is_empty());
    }

    #[test]
    fn inside_reads_literally() {
        assert!(inside("/a/b", "/a"));
        assert!(inside("/a", "/a/"));
        assert!(!inside("/ab", "/a"));
        assert!(!inside("a/b", "a"));
        assert!(!inside("/a/../b", "/a"));
        assert!(!inside("/a/b", ""));
        assert!(inside("/a/-x y", "/a"));
    }
}
