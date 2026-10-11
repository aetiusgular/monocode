//! `claude plugin` for the Plugins settings page and the per-chat plugin
//! switches: list the installed plugins, and enable or disable one.
//!
//! Only the argument shapes in `allowed` run. A plugin id must look
//! like `name@marketplace`, a scope is one of `user`, `project` or `local`,
//! and a project or local change runs in the project's own folder. The CLI is
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
const MAX_STDOUT_CHARS: usize = 1024 * 1024;
const MAX_STDERR_CHARS: usize = 16 * 1024;
const MAX_ERROR_CHARS: usize = 2000;
const MAX_ID_CHARS: usize = 200;
const MAX_ACCOUNT_ID_CHARS: usize = 80;

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
}

/// Run one allowlisted `claude plugin` command as a Claude Code provider
/// account. A list that fails is an error. An enable or disable returns its
/// output either way, because `--json` prints the reason on stdout and exits 1
/// (for example when the plugin is already in that state).
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
                stdout: bounded_to(&stdout, MAX_STDOUT_CHARS),
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
    };
    let toggle = |scope: Option<&str>| Shape {
        timeout: TOGGLE_TIMEOUT,
        needs_project: matches!(scope, Some("project" | "local")),
        reports_failure: true,
    };
    match args.as_slice() {
        ["plugin", "list", "--json"] | ["plugin", "list", "--json", "--available"] => Some(list),
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
        _ => None,
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
        assert!(shape(&["plugin", "install", "--scope", "user", "--json", "a@b"]).is_none());
        assert!(shape(&["plugin", "uninstall", "--scope", "user", "--json", "a@b"]).is_none());
        assert!(shape(&["plugin", "update", "--scope", "user", "--json", "a@b"]).is_none());
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
}
