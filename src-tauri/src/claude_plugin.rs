//! `claude plugin` for the Plugins settings page and the per-chat plugin
//! switches: list the installed plugins, enable or disable one, install,
//! update or uninstall one, and list, add, update or remove a marketplace.
//!
//! Only the argument shapes in `allowed` run. A plugin id must look
//! like `name@marketplace`, a scope is one of `user`, `project` or `local`,
//! and a project or local change runs in the project's own folder.
//!
//! No shape carries `-y`/`--yes`. A plugin installed by running a command the
//! marketplace declares is refused by Claude Code until that exact command is
//! accepted, so MonoCode shows the command it reported and passes
//! `--accept-command <sha256>` only after a click: that flag accepts that one
//! command for that plugin and catalog, and nothing else. `--prune`, which
//! needs `-y`, is never passed. The CLI is
//! the same `claude` binary sessions start, run as the same provider account
//! (`CLAUDE_CONFIG_DIR`), so the list is the one that account's sessions load.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::fs::expand_home;
use crate::harness::{
    apply_provider_account, exec_output_configured, resolve_mcp_binary, HarnessAccount, HarnessHost,
};

const LIST_TIMEOUT: Duration = Duration::from_secs(60);
const TOGGLE_TIMEOUT: Duration = Duration::from_secs(60);
/// Installs, updates and marketplace changes can clone a git repository.
const FETCH_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_STDOUT_CHARS: usize = 1024 * 1024;
/// `plugin list --json --available` lists every plugin of every marketplace:
/// 3,576 plugins came to 2.1 MB on the Mac test (finding 4.12). Read only.
const MAX_AVAILABLE_STDOUT_CHARS: usize = 16 * 1024 * 1024;
/// Shown when a reply is longer than its cap, instead of a cut reply that
/// would read as an empty list.
const TOO_LARGE: &str = "The plugin list was too large to read.";
const MAX_STDERR_CHARS: usize = 16 * 1024;
const MAX_ERROR_CHARS: usize = 2000;
const MAX_ID_CHARS: usize = 200;
const MAX_ACCOUNT_ID_CHARS: usize = 80;
const MAX_SOURCE_CHARS: usize = 2048;
const MAX_MARKETPLACE_CHARS: usize = 100;

#[derive(Serialize)]
pub struct ClaudePluginOutput {
    /// Bounded.
    stdout: String,
    /// Bounded.
    stderr: String,
    success: bool,
}

/// What one allowed call needs besides its arguments.
#[derive(Debug, PartialEq, Eq)]
struct Shape {
    timeout: Duration,
    /// The call changes a project's settings, so it must run in that project.
    needs_project: bool,
    /// The call prints a JSON result even when it fails.
    reports_failure: bool,
    /// The longest stdout read. A longer one is an error, never cut.
    stdout_limit: usize,
}

/// Run one allowlisted `claude plugin` command as a Claude Code provider
/// account. A list that fails is an error. Every change returns its output
/// either way, because `--json` prints the reason on stdout and exits 1 (for
/// example when the plugin is already in that state, or when an install
/// waits for its command to be accepted).
#[tauri::command]
pub async fn claude_plugin(
    app: AppHandle,
    host: State<'_, HarnessHost>,
    args: Vec<String>,
    cwd: Option<String>,
    account_id: Option<String>,
) -> Result<ClaudePluginOutput, String> {
    let shape = allowed(&args).ok_or_else(|| "claude_plugin: unsupported arguments".to_string())?;
    // A chat's folder can be `~` or start with it.
    let cwd = cwd.map(|dir| expand_home(&dir).to_string_lossy().into_owned());
    check_cwd(cwd.as_deref(), shape.needs_project)?;
    check_source_path(&args)?;
    let account = account_for(account_id)?;
    let binary_path = host.runtime_binary_path("claude");
    tauri::async_runtime::spawn_blocking(move || {
        let binary = resolve_mcp_binary("claude", binary_path.as_deref())?;
        let command = binary.to_string_lossy().into_owned();
        // A list with no project runs in the home folder, so a project's own
        // settings do not change what it reports for user plugins.
        let home = crate::dirs_home();
        let workdir = cwd.as_deref().or(home.as_deref());
        let output =
            exec_output_configured(&command, &args, workdir, shape.timeout, None, |cmd| {
                apply_provider_account(&app, cmd, account.as_ref())
            })?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let success = output.status.success();
        if success || shape.reports_failure {
            return Ok(ClaudePluginOutput {
                stdout: whole_stdout(&stdout, shape.stdout_limit)?,
                stderr: bounded_to(&stderr, MAX_STDERR_CHARS),
                success,
            });
        }
        let message = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        Err(bounded(message))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The shape of an allowed call, or None when it is not allowed.
fn allowed(args: &[String]) -> Option<Shape> {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let list = Shape {
        timeout: LIST_TIMEOUT,
        needs_project: false,
        reports_failure: false,
        stdout_limit: MAX_STDOUT_CHARS,
    };
    let toggle = |scope: Option<&str>| Shape {
        timeout: TOGGLE_TIMEOUT,
        needs_project: matches!(scope, Some("project" | "local")),
        reports_failure: true,
        stdout_limit: MAX_STDOUT_CHARS,
    };
    let fetch = |scope: Option<&str>| Shape {
        timeout: FETCH_TIMEOUT,
        needs_project: matches!(scope, Some("project" | "local")),
        reports_failure: true,
        stdout_limit: MAX_STDOUT_CHARS,
    };
    match args.as_slice() {
        ["plugin", "list", "--json"] => Some(list),
        ["plugin", "list", "--json", "--available"] => Some(Shape {
            stdout_limit: MAX_AVAILABLE_STDOUT_CHARS,
            ..list
        }),
        ["plugin", verb, "--scope", scope, "--json", id]
            if is_toggle(verb) && is_scope(scope) && is_plugin_id(id) && !is_synced(id) =>
        {
            Some(toggle(Some(scope)))
        }
        // A plugin synced from claude.ai has no install scope. Claude Code's
        // docs give `claude plugin disable <name>@synced` with no --scope; it
        // saves the choice in the user settings.
        ["plugin", verb, "--json", id] if is_toggle(verb) && is_synced(id) && is_plugin_id(id) => {
            Some(toggle(None))
        }
        ["plugin", "install" | "update", "--scope", scope, "--json", id]
        | ["plugin", "install" | "update", "--scope", scope, "--json", "--accept-command", _, id]
            if is_scope(scope) && is_plugin_id(id) && !is_synced(id) && accept_hash_ok(&args) =>
        {
            Some(fetch(Some(scope)))
        }
        ["plugin", "uninstall", "--scope", scope, "--json", id]
        | ["plugin", "uninstall", "--scope", scope, "--json", "--keep-data", id]
            if is_scope(scope) && is_plugin_id(id) && !is_synced(id) =>
        {
            Some(toggle(Some(scope)))
        }
        ["plugin", "marketplace", "list", "--json"] => Some(list),
        // Marketplaces are added to the user settings only, so a project's
        // shared settings never gain one from here.
        ["plugin", "marketplace", "add", "--scope", "user", "--json", source]
            if is_marketplace_source(source) =>
        {
            Some(fetch(None))
        }
        ["plugin", "marketplace", "update", "--json", name] if is_marketplace_name(name) => {
            Some(fetch(None))
        }
        ["plugin", "marketplace", "remove", "--json", name] if is_marketplace_name(name) => {
            Some(toggle(None))
        }
        _ => None,
    }
}

/// `--accept-command` takes a sha256 Claude Code reported: 64 lowercase hex
/// characters. Shapes without the flag pass.
fn accept_hash_ok(args: &[&str]) -> bool {
    match args.iter().position(|arg| *arg == "--accept-command") {
        None => true,
        Some(at) => args.get(at + 1).is_some_and(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }),
    }
}

/// A marketplace's name, as `claude plugin marketplace list` prints it.
fn is_marketplace_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_MARKETPLACE_CHARS
        && !value.starts_with('-')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Where a marketplace comes from. Three forms, checked by syntax here:
/// a GitHub `owner/repo`, an `https://` URL with a host and no user part, or
/// an absolute path (which must also exist, see `check_source_path`). Git
/// over ssh, `http://`, relative paths and anything starting with a dash are
/// refused.
fn is_marketplace_source(value: &str) -> bool {
    if value.is_empty()
        || value.len() > MAX_SOURCE_CHARS
        || value.starts_with('-')
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return false;
    }
    if value.starts_with('/') {
        return !value.split('/').any(|part| part == "..");
    }
    if value.contains("://") {
        return url::Url::parse(value).is_ok_and(|url| {
            url.scheme() == "https"
                && url.host_str().is_some_and(|host| !host.is_empty())
                && url.username().is_empty()
                && url.password().is_none()
        });
    }
    let part = |text: &str| {
        !text.is_empty()
            && text != "."
            && text != ".."
            && text
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    };
    value
        .split_once('/')
        .is_some_and(|(owner, repo)| part(owner) && part(repo) && !owner.starts_with('-'))
}

/// A path source must name a folder or file that exists, and must not be a
/// symbolic link, so what was reviewed is what gets read.
fn check_source_path(args: &[String]) -> Result<(), String> {
    let [_, _, verb, .., source] = args else {
        return Ok(());
    };
    if verb != "add" || !source.starts_with('/') {
        return Ok(());
    }
    let path = Path::new(source);
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err("claude_plugin: a marketplace path must not be a symbolic link".into())
        }
        Ok(_) => Ok(()),
        Err(_) => Err(format!("Marketplace path does not exist: {source}")),
    }
}

fn is_toggle(verb: &str) -> bool {
    verb == "enable" || verb == "disable"
}

fn is_scope(scope: &str) -> bool {
    matches!(scope, "user" | "project" | "local")
}

/// `^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$`, at most 200 characters, and not
/// starting with a dash, so it can never read as one of the CLI's flags.
fn is_plugin_id(value: &str) -> bool {
    let part = |text: &str| {
        !text.is_empty()
            && text
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    };
    value.len() <= MAX_ID_CHARS
        && !value.starts_with('-')
        && value
            .split_once('@')
            .is_some_and(|(name, origin)| part(name) && part(origin))
}

fn is_synced(id: &str) -> bool {
    id.ends_with("@synced")
}

/// A project or local change runs in the project's folder: an absolute path
/// to a directory that exists. Other calls take an optional folder, which
/// must exist when given.
fn check_cwd(cwd: Option<&str>, needs_project: bool) -> Result<(), String> {
    match cwd {
        None if needs_project => Err("claude_plugin: a project change needs its folder".into()),
        None => Ok(()),
        Some(dir) => {
            let path = Path::new(dir);
            if dir.len() > 4096 || dir.chars().any(char::is_control) || !path.is_absolute() {
                return Err("claude_plugin: the folder must be an absolute path".into());
            }
            if !path.is_dir() {
                return Err(format!("Project folder does not exist: {dir}"));
            }
            Ok(())
        }
    }
}

/// The Claude Code account to run as. None and `default` both mean the
/// default config folder. The id pattern is checked again where the folder
/// is made.
fn account_for(account_id: Option<String>) -> Result<Option<HarnessAccount>, String> {
    match account_id {
        None => Ok(None),
        Some(id)
            if !id.is_empty()
                && id.len() <= MAX_ACCOUNT_ID_CHARS
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') =>
        {
            Ok(Some(HarnessAccount {
                provider: "claude".into(),
                id,
            }))
        }
        Some(_) => Err("claude_plugin: invalid provider account id".into()),
    }
}

fn bounded_to(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// All of stdout, or an error when it is longer than `limit` characters. A
/// cut JSON reply does not parse and read as an empty list.
fn whole_stdout(text: &str, limit: usize) -> Result<String, String> {
    if text.len() > limit && text.chars().nth(limit).is_some() {
        return Err(TOO_LARGE.into());
    }
    Ok(text.to_string())
}

fn bounded(message: &str) -> String {
    if message.is_empty() {
        return "claude plugin failed".into();
    }
    bounded_to(message, MAX_ERROR_CHARS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|value| value.to_string()).collect()
    }

    fn shape(list: &[&str]) -> Option<Shape> {
        allowed(&args(list))
    }

    #[test]
    fn allows_list_with_and_without_available() {
        let list = shape(&["plugin", "list", "--json"]).unwrap();
        assert!(!list.needs_project);
        assert!(!list.reports_failure);
        assert!(shape(&["plugin", "list", "--json", "--available"]).is_some());
        assert!(shape(&["plugin", "list"]).is_none());
        assert!(shape(&["plugin", "list", "--available"]).is_none());
        assert!(shape(&["plugin", "list", "--available", "--json"]).is_none());
        assert!(shape(&["plugin", "list", "--json", "--verbose"]).is_none());
    }

    #[test]
    fn allows_enable_and_disable_at_a_scope() {
        for verb in ["enable", "disable"] {
            let user = shape(&[
                "plugin",
                verb,
                "--scope",
                "user",
                "--json",
                "obsidian@obsidian-skills",
            ])
            .unwrap();
            assert!(!user.needs_project);
            assert!(user.reports_failure);
            for scope in ["project", "local"] {
                let project = shape(&[
                    "plugin",
                    verb,
                    "--scope",
                    scope,
                    "--json",
                    "stripe@claude-plugins-official",
                ])
                .unwrap();
                assert!(project.needs_project);
            }
        }
    }

    #[test]
    fn allows_synced_plugins_only_without_a_scope() {
        assert!(shape(&["plugin", "disable", "--json", "browser-use@synced"]).is_some());
        assert!(shape(&["plugin", "enable", "--json", "browser-use@synced"]).is_some());
        assert!(shape(&["plugin", "disable", "--json", "stripe@official"]).is_none());
        assert!(shape(&[
            "plugin",
            "disable",
            "--scope",
            "user",
            "--json",
            "browser-use@synced"
        ])
        .is_none());
    }

    #[test]
    fn refuses_everything_else() {
        assert!(shape(&[]).is_none());
        assert!(shape(&["plugin"]).is_none());
        assert!(shape(&["mcp", "list"]).is_none());
        assert!(shape(&["plugin", "install", "--json", "a@b"]).is_none());
        assert!(shape(&["plugin", "install", "--scope", "user", "a@b"]).is_none());
        assert!(shape(&["plugin", "install", "--scope", "managed", "--json", "a@b"]).is_none());
        assert!(shape(&[
            "plugin",
            "uninstall",
            "--scope",
            "user",
            "--json",
            "--prune",
            "a@b"
        ])
        .is_none());
        assert!(shape(&["plugin", "update", "--json", "a@b"]).is_none());
        assert!(shape(&["plugin", "disable", "--all"]).is_none());
        assert!(shape(&["plugin", "disable", "--scope", "managed", "--json", "a@b"]).is_none());
        assert!(shape(&["plugin", "disable", "--scope", "user", "a@b"]).is_none());
        assert!(shape(&["plugin", "disable", "--scope", "user", "--json", "a@b", "x"]).is_none());
        assert!(shape(&["plugin", "disable", "--json", "--scope", "user", "a@b"]).is_none());
        assert!(shape(&["plugin", "enable", "-s", "user", "--json", "a@b"]).is_none());
    }

    #[test]
    fn checks_plugin_ids() {
        assert!(is_plugin_id("obsidian@obsidian-skills"));
        assert!(is_plugin_id("paper-desktop@paper"));
        assert!(is_plugin_id("a.b_c-1@X.y_z-2"));
        assert!(!is_plugin_id("stripe"));
        assert!(!is_plugin_id("@market"));
        assert!(!is_plugin_id("name@"));
        assert!(!is_plugin_id("a@b@c"));
        assert!(!is_plugin_id("--all@x"));
        assert!(!is_plugin_id("-x@y"));
        assert!(is_plugin_id("x@-y"));
        assert!(!is_plugin_id("a b@c"));
        assert!(!is_plugin_id("a/b@c"));
        assert!(!is_plugin_id("a@b;rm"));
        assert!(!is_plugin_id("é@b"));
        assert!(!is_plugin_id(&format!("{}@b", "a".repeat(MAX_ID_CHARS))));
    }

    #[test]
    fn a_leading_dash_id_cannot_pass_as_a_flag() {
        assert!(shape(&["plugin", "disable", "--scope", "user", "--json", "--all"]).is_none());
        assert!(shape(&["plugin", "disable", "--scope", "user", "--json", "--all@x"]).is_none());
        assert!(shape(&["plugin", "disable", "--json", "--all@synced"]).is_none());
    }

    #[test]
    fn project_changes_need_an_existing_absolute_folder() {
        let dir = std::env::temp_dir();
        let dir = dir.to_str().unwrap();
        assert!(check_cwd(None, false).is_ok());
        assert!(check_cwd(None, true).is_err());
        assert!(check_cwd(Some(dir), true).is_ok());
        assert!(check_cwd(Some("relative/path"), true).is_err());
        assert!(check_cwd(Some("/no/such/folder/for/claude/plugin"), false).is_err());
        assert!(check_cwd(Some("/tmp/a\nb"), false).is_err());
    }

    #[test]
    fn accounts_are_claude_and_plainly_named() {
        assert_eq!(account_for(None).unwrap(), None);
        let account = account_for(Some("account-1_a".into())).unwrap().unwrap();
        assert_eq!(account.provider, "claude");
        assert_eq!(account.id, "account-1_a");
        assert!(account_for(Some("default".into())).unwrap().is_some());
        assert!(account_for(Some(String::new())).is_err());
        assert!(account_for(Some("../x".into())).is_err());
        assert!(account_for(Some("a".repeat(81))).is_err());
    }

    #[test]
    fn bounds_output_and_errors() {
        assert_eq!(bounded(""), "claude plugin failed");
        assert_eq!(
            bounded(&"é".repeat(MAX_ERROR_CHARS + 10)).chars().count(),
            MAX_ERROR_CHARS
        );
        assert_eq!(bounded_to("abcdef", 3), "abc");
    }

    fn available_reply(bytes: usize) -> String {
        let entry = r#"{"pluginId":"p@m","name":"p","marketplaceName":"m","description":"x"},"#;
        let mut out = String::from(r#"{"installed":[],"available":["#);
        while out.len() + entry.len() < bytes {
            out.push_str(entry);
        }
        out.push_str(r#"{"pluginId":"last@m"}]}"#);
        out
    }

    #[test]
    fn the_available_list_reads_a_two_megabyte_reply_whole() {
        let shape = shape(&["plugin", "list", "--json", "--available"]).unwrap();
        let reply = available_reply(2_200_000);
        assert!(reply.len() > MAX_STDOUT_CHARS);
        let read = whole_stdout(&reply, shape.stdout_limit).unwrap();
        assert_eq!(read.len(), reply.len());
        let value: serde_json::Value = serde_json::from_str(&read).unwrap();
        assert!(value["available"].as_array().unwrap().len() > 20_000);
    }

    #[test]
    fn a_reply_over_its_cap_is_an_error_not_a_cut_list() {
        let available = shape(&["plugin", "list", "--json", "--available"]).unwrap();
        assert_eq!(available.stdout_limit, MAX_AVAILABLE_STDOUT_CHARS);
        let installed = shape(&["plugin", "list", "--json"]).unwrap();
        assert_eq!(installed.stdout_limit, MAX_STDOUT_CHARS);
        assert_eq!(
            whole_stdout(&available_reply(2_200_000), installed.stdout_limit),
            Err(TOO_LARGE.to_string())
        );
        assert_eq!(whole_stdout("abc", 3), Ok("abc".into()));
        assert_eq!(whole_stdout("abcd", 3), Err(TOO_LARGE.to_string()));
        // Characters, not bytes: three two-byte characters fit a cap of 3.
        assert_eq!(whole_stdout("ééé", 3), Ok("ééé".into()));
    }

    const HASH: &str = "4dfac0a00339d273c4d73168fd2ac0bddbcb6b706484954fdbfdc21457660b6f";

    #[test]
    fn allows_install_update_and_uninstall_at_a_scope() {
        for verb in ["install", "update", "uninstall"] {
            let user =
                shape(&["plugin", verb, "--scope", "user", "--json", "hello@testmk"]).unwrap();
            assert!(!user.needs_project);
            assert!(user.reports_failure);
            for scope in ["project", "local"] {
                let project =
                    shape(&["plugin", verb, "--scope", scope, "--json", "hello@testmk"]).unwrap();
                assert!(project.needs_project);
            }
            assert!(shape(&["plugin", verb, "--scope", "user", "--json", "x@synced"]).is_none());
            assert!(shape(&["plugin", verb, "--scope", "user", "--json", "--all@x"]).is_none());
        }
        assert_eq!(
            shape(&["plugin", "install", "--scope", "user", "--json", "a@b"])
                .unwrap()
                .timeout,
            FETCH_TIMEOUT
        );
        assert!(shape(&[
            "plugin",
            "uninstall",
            "--scope",
            "user",
            "--json",
            "--keep-data",
            "a@b"
        ])
        .is_some());
        assert!(shape(&[
            "plugin",
            "install",
            "--scope",
            "user",
            "--json",
            "--keep-data",
            "a@b"
        ])
        .is_none());
    }

    #[test]
    fn never_accepts_a_command_without_its_hash() {
        for verb in ["install", "update"] {
            assert!(shape(&[
                "plugin",
                verb,
                "--scope",
                "user",
                "--json",
                "--accept-command",
                HASH,
                "a@b"
            ])
            .is_some());
            for bad in [
                "",
                "abc",
                &HASH.to_uppercase(),
                &format!("{HASH}0"),
                &HASH[1..],
                "--yes",
            ] {
                assert!(
                    shape(&[
                        "plugin",
                        verb,
                        "--scope",
                        "user",
                        "--json",
                        "--accept-command",
                        bad,
                        "a@b"
                    ])
                    .is_none(),
                    "{bad}"
                );
            }
            for flag in ["-y", "--yes"] {
                assert!(
                    shape(&["plugin", verb, "--scope", "user", "--json", flag, "a@b"]).is_none()
                );
                assert!(
                    shape(&["plugin", verb, "--scope", "user", flag, "--json", "a@b"]).is_none()
                );
            }
        }
        assert!(shape(&[
            "plugin",
            "uninstall",
            "--scope",
            "user",
            "--json",
            "--accept-command",
            HASH,
            "a@b"
        ])
        .is_none());
    }

    #[test]
    fn allows_marketplace_list_add_update_and_remove() {
        assert!(
            !shape(&["plugin", "marketplace", "list", "--json"])
                .unwrap()
                .reports_failure
        );
        assert!(shape(&["plugin", "marketplace", "list"]).is_none());
        let add = shape(&[
            "plugin",
            "marketplace",
            "add",
            "--scope",
            "user",
            "--json",
            "owner/repo",
        ])
        .unwrap();
        assert!(!add.needs_project);
        assert!(add.reports_failure);
        assert!(shape(&[
            "plugin",
            "marketplace",
            "add",
            "--scope",
            "project",
            "--json",
            "owner/repo"
        ])
        .is_none());
        assert!(shape(&["plugin", "marketplace", "add", "--json", "owner/repo"]).is_none());
        assert!(shape(&[
            "plugin",
            "marketplace",
            "add",
            "--scope",
            "user",
            "--json",
            "--claudeai"
        ])
        .is_none());
        assert!(shape(&[
            "plugin",
            "marketplace",
            "add",
            "--scope",
            "user",
            "--json",
            "a/b",
            "--sparse",
            "x"
        ])
        .is_none());
        assert!(shape(&["plugin", "marketplace", "update", "--json", "testmk"]).is_some());
        assert!(shape(&["plugin", "marketplace", "update"]).is_none());
        assert!(shape(&["plugin", "marketplace", "update", "--json"]).is_none());
        assert!(shape(&["plugin", "marketplace", "remove", "--json", "testmk"]).is_some());
        assert!(shape(&["plugin", "marketplace", "remove", "--json", "--scope"]).is_none());
        assert!(shape(&["plugin", "marketplace", "rm", "--json", "testmk"]).is_none());
    }

    #[test]
    fn checks_marketplace_sources() {
        for good in [
            "anthropics/claude-plugins-official",
            "a.b_c/d-e.f",
            "https://github.com/owner/repo.git",
            "https://example.com/marketplace.json",
            "/Users/tony/my-marketplace",
            "/tmp/mk",
        ] {
            assert!(is_marketplace_source(good), "{good}");
        }
        for bad in [
            "",
            "-x/y",
            "--claudeai",
            "owner",
            "owner/repo/extra",
            "../repo",
            "./mk",
            "mk",
            "a b/c",
            "/tmp/../etc",
            "/tmp/a\nb",
            "/tmp/a b",
            "http://example.com/m.json",
            "git@github.com:owner/repo.git",
            "ssh://git@github.com/owner/repo",
            "file:///etc/passwd",
            "https://user:pw@example.com/m.json",
            "https://user@example.com/m.json",
            "https://",
            "https://:443/x",
            "owner/..",
            "./x",
        ] {
            assert!(!is_marketplace_source(bad), "{bad}");
        }
        assert!(!is_marketplace_source(&format!(
            "a/{}",
            "b".repeat(MAX_SOURCE_CHARS)
        )));
    }

    #[test]
    fn checks_marketplace_names() {
        assert!(is_marketplace_name("anthropic-plugin-directory"));
        assert!(is_marketplace_name("a.b_c"));
        assert!(!is_marketplace_name(""));
        assert!(!is_marketplace_name("-x"));
        assert!(!is_marketplace_name("a/b"));
        assert!(!is_marketplace_name("a b"));
        assert!(!is_marketplace_name(&"a".repeat(MAX_MARKETPLACE_CHARS + 1)));
    }

    #[test]
    fn a_path_source_must_exist_and_not_be_a_link() {
        let dir = std::env::temp_dir().join(format!("mc-mk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let add = |source: &str| {
            args(&[
                "plugin",
                "marketplace",
                "add",
                "--scope",
                "user",
                "--json",
                source,
            ])
        };
        assert!(check_source_path(&add(dir.to_str().unwrap())).is_ok());
        assert!(check_source_path(&add("/no/such/marketplace/here")).is_err());
        assert!(check_source_path(&add("owner/repo")).is_ok());
        #[cfg(unix)]
        {
            let link = dir.with_extension("link");
            let _ = std::fs::remove_file(&link);
            std::os::unix::fs::symlink(&dir, &link).unwrap();
            assert!(check_source_path(&add(link.to_str().unwrap())).is_err());
            std::fs::remove_file(&link).unwrap();
        }
        assert!(check_source_path(&args(&["plugin", "list", "--json"])).is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
