//! #45: the Claude Code sessions recorded for a folder, read from the
//! account's transcript files under `<config>/projects/<folder>/`, so a chat
//! can pick one up with `--resume`.
//!
//! Read only. Claude Code documents no command that lists sessions, and its
//! file format changes between versions, so this reads only what it needs
//! from the head of each file: the folder it was recorded in, a title and the
//! first prompt. Paths stay inside the account's `projects` folder: the
//! folder name is derived from the chat's folder, symbolic links are refused,
//! and file names are taken literally and checked as session ids.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

/// Bytes read from the head of one transcript.
const HEAD_BYTES: u64 = 512 * 1024;
/// Transcript files looked at in one folder, newest first.
const MAX_FILES: usize = 200;
/// Directory entries scanned in one folder.
const MAX_ENTRIES: usize = 5_000;
/// Rows returned.
const MAX_ROWS: usize = 100;
const MAX_TITLE_CHARS: usize = 200;
const MAX_ID_CHARS: usize = 128;
const MAX_CWD_CHARS: usize = 4_096;
const MAX_ACCOUNT_ID_CHARS: usize = 80;
/// Claude Code shortens long folder names and adds a hash; the first 200
/// characters stay as they are.
const KEPT_PREFIX: usize = 200;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionRow {
    id: String,
    title: String,
    updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

/// Lists the Claude Code sessions recorded in `cwd` for the account.
#[tauri::command]
pub async fn claude_sessions_list(
    app: AppHandle,
    cwd: String,
    account_id: Option<String>,
) -> Result<Vec<ClaudeSessionRow>, String> {
    check_cwd(&cwd)?;
    let root = config_dir(&app, account_id.as_deref())?.join("projects");
    tauri::async_runtime::spawn_blocking(move || list_in(&root, &cwd))
        .await
        .map_err(|error| error.to_string())?
}

fn config_dir(app: &AppHandle, account_id: Option<&str>) -> Result<PathBuf, String> {
    match account_id {
        Some(id) if id != "default" => {
            if id.is_empty()
                || id.len() > MAX_ACCOUNT_ID_CHARS
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
            {
                return Err("Invalid Claude Code account id".into());
            }
            crate::harness::provider_account_path(app, "claude", id)
        }
        _ => match std::env::var_os("CLAUDE_CONFIG_DIR") {
            Some(path) if !path.is_empty() => Ok(PathBuf::from(path)),
            _ => Ok(
                PathBuf::from(crate::dirs_home().ok_or("Home directory is unavailable")?)
                    .join(".claude"),
            ),
        },
    }
}

fn check_cwd(cwd: &str) -> Result<(), String> {
    if cwd.is_empty() || cwd.len() > MAX_CWD_CHARS || cwd.contains('\0') {
        return Err("Invalid folder".into());
    }
    if !Path::new(cwd).is_absolute() {
        return Err("The folder must be an absolute path".into());
    }
    Ok(())
}

/// Claude Code's folder name for a project: every character that is not an
/// ASCII letter or digit becomes `-`.
pub(crate) fn project_folder_name(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn trim_slashes(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        path
    } else {
        trimmed
    }
}

fn is_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_CHARS
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// A real directory inside `root`, not reached through a symbolic link.
fn inside_dir(root: &Path, dir: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(dir) else {
        return false;
    };
    if !meta.is_dir() {
        return false;
    }
    match (fs::canonicalize(root), fs::canonicalize(dir)) {
        (Ok(root), Ok(dir)) => dir.starts_with(&root) && dir != root,
        _ => false,
    }
}

fn project_dirs(root: &Path, cwd: &str) -> Vec<PathBuf> {
    let name = project_folder_name(trim_slashes(cwd));
    let mut dirs = Vec::new();
    let exact = root.join(&name);
    if inside_dir(root, &exact) {
        dirs.push(exact);
    }
    if name.len() > KEPT_PREFIX {
        let prefix = &name[..KEPT_PREFIX];
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten().take(MAX_ENTRIES) {
                let entry_name = entry.file_name();
                let Some(entry_name) = entry_name.to_str() else {
                    continue;
                };
                if entry_name != name && entry_name.starts_with(prefix) {
                    let path = entry.path();
                    if inside_dir(root, &path) {
                        dirs.push(path);
                    }
                }
            }
        }
    }
    dirs
}

pub(crate) fn list_in(root: &Path, cwd: &str) -> Result<Vec<ClaudeSessionRow>, String> {
    check_cwd(cwd)?;
    let mut files: Vec<(u64, String, PathBuf)> = Vec::new();
    for dir in project_dirs(root, cwd) {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten().take(MAX_ENTRIES) {
            let file_name = entry.file_name();
            let Some(file_name) = file_name.to_str() else {
                continue;
            };
            let Some(id) = file_name.strip_suffix(".jsonl") else {
                continue;
            };
            // Subagent side chains are written beside the session itself.
            if !is_session_id(id) || id.starts_with("agent-") {
                continue;
            }
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if !meta.file_type().is_file() {
                continue;
            }
            let modified = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|time| time.as_millis() as u64)
                .unwrap_or(0);
            files.push((modified, id.to_string(), path));
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    files.dedup_by(|a, b| a.1 == b.1);
    let mut rows = Vec::new();
    for (modified, id, path) in files.into_iter().take(MAX_FILES) {
        let Some(head) = read_head(&path) else {
            continue;
        };
        let Some(row) = row_from_head(&id, modified, &head, cwd) else {
            continue;
        };
        rows.push(row);
        if rows.len() >= MAX_ROWS {
            break;
        }
    }
    Ok(rows)
}

/// Bytes read from the end of a transcript to find its last entry.
const TAIL_BYTES: u64 = 4 * 1024 * 1024;

/// The uuid of the last message or tool result on the main chain of one
/// Claude Code conversation, read from the end of its transcript file. A
/// prompt sent after a `--resume` follows that entry, so it is where a chat
/// rewind cuts back to (1.6). None when there is no such file, the entry is
/// not in the last 4 MB, or a compaction came after it.
#[tauri::command]
pub async fn claude_session_last_entry(
    app: AppHandle,
    cwd: String,
    session_id: String,
    account_id: Option<String>,
) -> Result<Option<String>, String> {
    check_cwd(&cwd)?;
    if !is_session_id(&session_id) {
        return Err("Invalid Claude Code session id".into());
    }
    let root = config_dir(&app, account_id.as_deref())?.join("projects");
    tauri::async_runtime::spawn_blocking(move || Ok(last_entry_in(&root, &cwd, &session_id)))
        .await
        .map_err(|error| error.to_string())?
}

pub(crate) fn last_entry_in(root: &Path, cwd: &str, session_id: &str) -> Option<String> {
    if !is_session_id(session_id) {
        return None;
    }
    let name = format!("{session_id}.jsonl");
    for dir in project_dirs(root, cwd) {
        let path = dir.join(&name);
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.file_type().is_file() {
            continue;
        }
        return read_tail(&path, meta.len()).and_then(|tail| last_entry_from(&tail));
    }
    None
}

fn read_tail(path: &Path, len: u64) -> Option<String> {
    use std::io::{Seek, SeekFrom};
    let mut file = fs::File::open(path).ok()?;
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(TAIL_BYTES).read_to_end(&mut bytes).ok()?;
    // A line cut by the start of the window is dropped.
    if start > 0 {
        let first = bytes.iter().position(|byte| *byte == b'\n')?;
        bytes.drain(..=first);
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Same rule as the live stream: user and assistant entries off the side
/// chains count, and a compaction forgets the entries before it.
pub(crate) fn last_entry_from(tail: &str) -> Option<String> {
    let mut last: Option<String> = None;
    for raw in tail.lines() {
        let Ok(line) = serde_json::from_str::<Value>(raw) else {
            continue;
        };
        let kind = line.get("type").and_then(Value::as_str);
        if kind == Some("system")
            && line.get("subtype").and_then(Value::as_str) == Some("compact_boundary")
        {
            last = None;
            continue;
        }
        if kind != Some("user") && kind != Some("assistant") {
            continue;
        }
        if line.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let Some(uuid) = line.get("uuid").and_then(Value::as_str) else {
            continue;
        };
        if is_session_id(uuid) {
            last = Some(uuid.to_string());
        }
    }
    last
}

fn read_head(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(HEAD_BYTES).read_to_end(&mut bytes).ok()?;
    // A line cut by the limit is dropped.
    if bytes.len() as u64 >= HEAD_BYTES {
        let end = bytes.iter().rposition(|byte| *byte == b'\n').unwrap_or(0);
        bytes.truncate(end);
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn clean_title(text: &str) -> String {
    let mut out = String::new();
    let mut space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            space = !out.is_empty();
            continue;
        }
        if c.is_control() {
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.push(c);
        if out.chars().count() >= MAX_TITLE_CHARS {
            break;
        }
    }
    out
}

/// Text of a user line that a person typed, or None for tool results, meta
/// lines and the command wrappers Claude Code records.
fn prompt_text(line: &Value) -> Option<String> {
    if line.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let content = line.get("message")?.get("content")?;
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    let trimmed = text.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("<command-")
        || trimmed.starts_with("<local-command")
        || trimmed.starts_with("<system-reminder>")
        || trimmed.starts_with("Caveat:")
    {
        return None;
    }
    Some(trimmed.to_string())
}

pub(crate) fn row_from_head(
    id: &str,
    modified: u64,
    head: &str,
    cwd: &str,
) -> Option<ClaudeSessionRow> {
    let wanted = trim_slashes(cwd);
    let mut seen_cwd: Option<String> = None;
    let mut prompt: Option<String> = None;
    let mut summary: Option<String> = None;
    let mut custom: Option<String> = None;
    let mut version: Option<String> = None;
    let mut any_line = false;
    for raw in head.lines() {
        let Ok(line) = serde_json::from_str::<Value>(raw) else {
            continue;
        };
        any_line = true;
        if line.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if seen_cwd.is_none() {
            if let Some(found) = line.get("cwd").and_then(Value::as_str) {
                seen_cwd = Some(found.to_string());
            }
        }
        if version.is_none() {
            if let Some(found) = line.get("version").and_then(Value::as_str) {
                version = Some(clean_title(found));
            }
        }
        match line.get("type").and_then(Value::as_str) {
            Some("user") if prompt.is_none() => prompt = prompt_text(&line),
            Some("summary") => {
                if let Some(text) = line.get("summary").and_then(Value::as_str) {
                    summary = Some(text.to_string());
                }
            }
            Some("custom-title") => {
                if let Some(text) = line.get("customTitle").and_then(Value::as_str) {
                    custom = Some(text.to_string());
                }
            }
            _ => {}
        }
    }
    if !any_line {
        return None;
    }
    // A file the folder name led to but recorded elsewhere is not this
    // folder's: two folders can share one Claude Code folder name.
    if let Some(found) = &seen_cwd {
        if trim_slashes(found) != wanted {
            return None;
        }
    }
    // A session with nothing typed in it yet has nothing to pick up.
    let title = custom
        .or(summary)
        .or(prompt.clone())
        .map(|text| clean_title(&text))
        .filter(|text| !text.is_empty())?;
    let detail = version
        .filter(|version| !version.is_empty())
        .map(|version| format!("recorded by Claude Code {version}"));
    Some(ClaudeSessionRow {
        id: id.to_string(),
        title,
        updated_at: modified,
        detail,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "monocode-claude-sessions-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn user_line(cwd: &str, text: &str) -> String {
        serde_json::json!({
            "type": "user",
            "cwd": cwd,
            "version": "2.1.292",
            "isSidechain": false,
            "message": { "role": "user", "content": text },
        })
        .to_string()
    }

    fn write(path: &Path, lines: &[String]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, lines.join("\n") + "\n").unwrap();
    }

    #[test]
    fn folder_name_replaces_every_non_alphanumeric() {
        assert_eq!(
            project_folder_name("/Users/tony/my proj.v2"),
            "-Users-tony-my-proj-v2"
        );
        assert_eq!(project_folder_name("/a/-dash"), "-a--dash");
    }

    #[test]
    fn lists_sessions_newest_first_with_titles() {
        let root = scratch();
        let cwd = "/Users/tony/my proj";
        let dir = root.join(project_folder_name(cwd));
        write(
            &dir.join("11111111-aaaa.jsonl"),
            &[user_line(cwd, "fix the build")],
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
        write(
            &dir.join("22222222-bbbb.jsonl"),
            &[
                user_line(cwd, "<command-name>/clear</command-name>"),
                user_line(cwd, "write   the\nREADME"),
                serde_json::json!({"type": "summary", "summary": "README work"}).to_string(),
            ],
        );
        let rows = list_in(&root, cwd).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "22222222-bbbb");
        assert_eq!(rows[0].title, "README work");
        assert_eq!(
            rows[0].detail.as_deref(),
            Some("recorded by Claude Code 2.1.292")
        );
        assert_eq!(rows[1].title, "fix the build");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn first_prompt_skips_meta_and_command_wrappers() {
        let cwd = "/p";
        let meta = serde_json::json!({
            "type": "user", "cwd": cwd, "isMeta": true,
            "message": {"role": "user", "content": "hidden"},
        })
        .to_string();
        let parts = serde_json::json!({
            "type": "user", "cwd": cwd,
            "message": {"role": "user", "content": [
                {"type": "tool_result", "content": "x"},
                {"type": "text", "text": "  plan  the\tmigration "},
            ]},
        })
        .to_string();
        let head = [meta, parts].join("\n");
        let row = row_from_head("abc", 5, &head, cwd).unwrap();
        assert_eq!(row.title, "plan the migration");
    }

    #[test]
    fn skips_files_recorded_in_another_folder_sharing_the_name() {
        let root = scratch();
        // "/a b" and "/a-b" share the folder name "-a-b".
        let dir = root.join(project_folder_name("/a b"));
        write(&dir.join("s1.jsonl"), &[user_line("/a-b", "other folder")]);
        write(&dir.join("s2.jsonl"), &[user_line("/a b", "this folder")]);
        let rows = list_in(&root, "/a b").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "s2");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skips_side_chains_bad_names_and_empty_sessions() {
        let root = scratch();
        let cwd = "/p";
        let dir = root.join(project_folder_name(cwd));
        write(&dir.join("agent-123.jsonl"), &[user_line(cwd, "sub")]);
        write(&dir.join("-flag.jsonl"), &[user_line(cwd, "dash")]);
        write(&dir.join("has space.jsonl"), &[user_line(cwd, "space")]);
        write(&dir.join("notes.txt"), &[user_line(cwd, "txt")]);
        write(
            &dir.join("empty.jsonl"),
            &[serde_json::json!({"type": "system", "cwd": cwd}).to_string()],
        );
        write(&dir.join("garbage.jsonl"), &["not json".to_string()]);
        write(&dir.join("good.jsonl"), &[user_line(cwd, "kept")]);
        let rows = list_in(&root, cwd).unwrap();
        let ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
        assert_eq!(ids, vec!["good"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symbolic_links_out_of_the_projects_folder() {
        let root = scratch();
        let outside = scratch();
        let cwd = "/p";
        write(&outside.join("leak.jsonl"), &[user_line(cwd, "outside")]);
        // The folder itself a link.
        std::os::unix::fs::symlink(&outside, root.join(project_folder_name(cwd))).unwrap();
        assert!(list_in(&root, cwd).unwrap().is_empty());
        // A file inside a real folder that is a link.
        let root2 = scratch();
        let dir = root2.join(project_folder_name(cwd));
        fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(outside.join("leak.jsonl"), dir.join("link.jsonl")).unwrap();
        assert!(list_in(&root2, cwd).unwrap().is_empty());
        for dir in [root, root2, outside] {
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn missing_projects_folder_is_an_empty_list() {
        let root = scratch().join("nope");
        assert!(list_in(&root, "/p").unwrap().is_empty());
    }

    #[test]
    fn refuses_relative_and_odd_folders() {
        let root = scratch();
        assert!(list_in(&root, "relative/path").is_err());
        assert!(list_in(&root, "").is_err());
        assert!(list_in(&root, "/a\0b").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn trailing_slash_matches() {
        let root = scratch();
        let dir = root.join(project_folder_name("/p/q"));
        write(&dir.join("s.jsonl"), &[user_line("/p/q/", "x")]);
        assert_eq!(list_in(&root, "/p/q/").unwrap().len(), 1);
        assert_eq!(list_in(&root, "/p/q").unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn long_folder_names_match_by_their_kept_prefix() {
        let root = scratch();
        let cwd = format!("/{}", "deep/".repeat(60));
        let name = project_folder_name(trim_slashes(&cwd));
        assert!(name.len() > KEPT_PREFIX);
        let shortened = format!("{}-abc123", &name[..KEPT_PREFIX]);
        write(
            &root.join(shortened).join("s.jsonl"),
            &[user_line(trim_slashes(&cwd), "long")],
        );
        assert_eq!(list_in(&root, &cwd).unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn control_characters_never_reach_a_title() {
        let row = row_from_head("s", 1, &user_line("/p", "a\u{1b}[31mred\u{7}"), "/p").unwrap();
        assert_eq!(row.title, "a[31mred");
    }

    #[test]
    fn a_line_cut_by_the_head_limit_is_dropped() {
        let root = scratch();
        let cwd = "/p";
        let dir = root.join(project_folder_name(cwd));
        let big = "x".repeat(HEAD_BYTES as usize);
        write(
            &dir.join("s.jsonl"),
            &[user_line(cwd, "first"), user_line(cwd, &big)],
        );
        let rows = list_in(&root, cwd).unwrap();
        assert_eq!(rows[0].title, "first");
        fs::remove_dir_all(root).unwrap();
    }

    fn entry(kind: &str, uuid: &str, sidechain: bool) -> String {
        serde_json::json!({
            "type": kind,
            "uuid": uuid,
            "isSidechain": sidechain,
            "message": { "role": kind, "content": "x" },
        })
        .to_string()
    }

    #[test]
    fn finds_the_last_main_chain_entry() {
        let root = scratch();
        let cwd = "/Users/tony/my proj";
        let dir = root.join(project_folder_name(cwd));
        write(
            &dir.join("sess-1.jsonl"),
            &[
                entry("user", "u-1", false),
                entry("assistant", "a-1", false),
                entry("assistant", "side-1", true),
                serde_json::json!({"type": "summary", "summary": "s"}).to_string(),
                "not json".to_string(),
            ],
        );
        assert_eq!(last_entry_in(&root, cwd, "sess-1").as_deref(), Some("a-1"));
        assert_eq!(last_entry_in(&root, cwd, "missing"), None);
        assert_eq!(last_entry_in(&root, cwd, "../sess-1"), None);
        assert_eq!(last_entry_in(&root, "/other", "sess-1"), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_compaction_forgets_the_entries_before_it() {
        let tail = [
            entry("assistant", "a-1", false),
            serde_json::json!({"type": "system", "subtype": "compact_boundary"}).to_string(),
        ]
        .join("\n");
        assert_eq!(last_entry_from(&tail), None);
        let after = format!("{tail}\n{}", entry("assistant", "a-2", false));
        assert_eq!(last_entry_from(&after).as_deref(), Some("a-2"));
    }

    #[test]
    fn refuses_a_uuid_that_is_not_an_id() {
        assert_eq!(last_entry_from(&entry("user", "-c x", false)), None);
        assert_eq!(last_entry_from(&entry("user", "a b", false)), None);
    }

    #[test]
    fn reads_only_the_tail_of_a_long_transcript() {
        let root = scratch();
        let cwd = "/p";
        let dir = root.join(project_folder_name(cwd));
        let big = "x".repeat(TAIL_BYTES as usize);
        write(
            &dir.join("s.jsonl"),
            &[entry("user", &big, false), entry("assistant", "a-9", false)],
        );
        assert_eq!(last_entry_in(&root, cwd, "s").as_deref(), Some("a-9"));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_transcript_reached_through_a_symlink() {
        let root = scratch();
        let cwd = "/p";
        let dir = root.join(project_folder_name(cwd));
        let outside = scratch();
        write(&outside.join("leak.jsonl"), &[entry("user", "u-1", false)]);
        fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(outside.join("leak.jsonl"), dir.join("s.jsonl")).unwrap();
        assert_eq!(last_entry_in(&root, cwd, "s"), None);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
