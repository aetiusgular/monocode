//! Keeps commands named in a repository's own git config from running when
//! MonoCode reads the repository on its own.
//!
//! An agent, or a stranger's repository, can write `.git/config`,
//! `.git/info/attributes` and `.gitattributes`. A filter driver or a diff
//! driver named there is a shell command, and git runs it on a plain
//! `git diff` or `git status`. MonoCode polls those for the Changes panel every
//! few seconds, so such a command would run with the user's full rights and no
//! click (Mac test, finding 10.1). `--attr-source` alone is not enough: git
//! still reads `.git/info/attributes`.
//!
//! For a read, every filter and diff driver defined in the repository's own
//! config (local or worktree scope, includes followed) is switched off for that
//! one call, and `core.fsmonitor` is off for every call. Drivers from the
//! user's global or system config, such as git-lfs installed globally, are left
//! alone. Writes the user clicks (`add`, `commit`, `checkout` and the like)
//! keep the filters and hooks, because a filter shapes what is stored. Writes
//! MonoCode makes on its own, such as the turn checkpoint, go through
//! `guard_everything_pinned`, which holds them too. Reads and those writes also run
//! no hook. A submodule's own config is not read, so reads leave dirty
//! submodules alone.

use std::path::Path;
use std::process::Command;

/// Subcommands that store or rewrite content, where a filter decides what is
/// written. They keep the repository's filters.
const WRITES: &[&str] = &[
    "add",
    "am",
    "apply",
    "checkout",
    "checkout-index",
    "cherry-pick",
    "clean",
    "clone",
    "commit",
    "commit-tree",
    "hash-object",
    "merge",
    "mv",
    "pull",
    "read-tree",
    "rebase",
    "reset",
    "restore",
    "revert",
    "rm",
    "stash",
    "switch",
    "update-index",
    "worktree",
];

/// Subcommands that can run a diff driver. They get `--no-ext-diff`.
const DIFFS: &[&str] = &["diff", "log", "show"];

/// The subcommand in an argument list, past leading global options.
pub(crate) fn subcommand<'a>(args: &[&'a str]) -> Option<&'a str> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match *arg {
            "-c" | "-C" | "--git-dir" | "--work-tree" => {
                iter.next();
            }
            other if other.starts_with('-') => {}
            other => return Some(other),
        }
    }
    None
}

pub(crate) fn is_write(args: &[&str]) -> bool {
    subcommand(args).is_some_and(|sub| WRITES.contains(&sub))
}

/// Driver names a repository's own config defines, from
/// `git config -z --show-scope --get-regexp` output.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct RepoDrivers {
    pub filters: Vec<String>,
    pub diffs: Vec<String>,
}

/// Parses `-z --show-scope` output: `scope\0key\nvalue\0` per entry. Keeps
/// only the repository's own scopes. `Err` when a name cannot be passed back
/// to git safely as `-c <name>=`.
pub(crate) fn parse_repo_drivers(raw: &[u8]) -> Result<RepoDrivers, String> {
    // Strict: a lossy decode turns a name that is not UTF-8 into another
    // name, and the real driver would still run (security review, F2).
    let text = std::str::from_utf8(raw).map_err(|_| {
        "This repository's git config names a driver MonoCode cannot switch off safely.".to_string()
    })?;
    let mut parts = text.split('\0');
    let mut drivers = RepoDrivers::default();
    while let Some(scope) = parts.next() {
        let Some(entry) = parts.next() else { break };
        if !matches!(scope, "local" | "worktree") {
            continue;
        }
        let key = entry.split('\n').next().unwrap_or("");
        let (list, rest) = if let Some(rest) = key.strip_prefix("filter.") {
            (&mut drivers.filters, rest)
        } else if let Some(rest) = key.strip_prefix("diff.") {
            (&mut drivers.diffs, rest)
        } else {
            continue;
        };
        // `filter.<name>.<variable>`; a name may hold dots, the variable not.
        let Some((name, _variable)) = rest.rsplit_once('.') else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        if name.contains('=') || name.chars().any(char::is_control) {
            return Err(format!(
                "This repository's git config names a driver MonoCode cannot switch off safely ({name:?})."
            ));
        }
        if !list.iter().any(|known| known == name) {
            list.push(name.to_string());
        }
    }
    Ok(drivers)
}

/// The `-c` overrides that switch a repository's own drivers off for one read.
pub(crate) fn override_args(drivers: &RepoDrivers) -> Vec<String> {
    let mut args = Vec::new();
    for name in &drivers.filters {
        for (variable, value) in [
            ("clean", ""),
            ("smudge", ""),
            ("process", ""),
            ("required", "false"),
        ] {
            args.push("-c".to_string());
            args.push(format!("filter.{name}.{variable}={value}"));
        }
    }
    for name in &drivers.diffs {
        // An empty textconv makes git fail to diff; `cat` gives the raw text,
        // which is what the diff shows with no driver at all.
        args.push("-c".to_string());
        args.push(format!("diff.{name}.textconv=cat"));
        args.push("-c".to_string());
        args.push(format!("diff.{name}.cachetextconv=false"));
    }
    args
}

/// A `git` command for MonoCode's own config reads: no prompt, no optional
/// lock, and messages in English whatever the user's locale.
pub(crate) fn plain_git() -> Command {
    let mut command = Command::new("git");
    crate::hide_window_console(&mut command);
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0");
    english(&mut command);
    command
}

/// Git's messages in English whatever the user's locale, for a call whose
/// error text MonoCode reads ("not a git repository").
pub(crate) fn english(command: &mut Command) -> &mut Command {
    command.env("LC_ALL", "C").env("LANGUAGE", "")
}

fn repo_drivers(root: &Path, envs: &[(&str, &std::ffi::OsStr)]) -> Result<RepoDrivers, String> {
    let mut command = plain_git();
    for (name, value) in envs {
        command.env(name, value);
    }
    let output = command
        .args(["-c", "core.fsmonitor=false", "-C"])
        .arg(root)
        .args([
            "config",
            "-z",
            "--includes",
            "--show-scope",
            "--get-regexp",
            r"^(filter|diff)\.",
        ])
        .output()
        .map_err(|error| error.to_string())?;
    // Exit 1 means no key matched.
    match output.status.code() {
        Some(0) => parse_repo_drivers(&output.stdout),
        Some(1) => Ok(RepoDrivers::default()),
        _ => Err("git could not read this repository's config.".into()),
    }
}

/// Whether a config value reads as a boolean, which names no command.
fn is_boolean(value: Option<&str>) -> bool {
    match value {
        None => true,
        Some(value) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "" | "true" | "false" | "yes" | "no" | "on" | "off" | "1" | "0"
        ),
    }
}

/// Whether one config entry names a command that a read-only git subcommand
/// (`status`, `diff`, `log`, `show`, `grep`, `blame`, `branch`, `ls-files`,
/// `rev-parse`) could run. `key` as git prints it: section and variable in
/// lower case, a subsection as written.
fn entry_names_command(key: &str, value: Option<&str>) -> bool {
    let Some((section, rest)) = key.split_once('.') else {
        return false;
    };
    // The variable is after the last dot; a subsection may hold dots.
    let (subsection, variable) = match rest.rsplit_once('.') {
        Some((sub, var)) => (Some(sub), var),
        None => (None, rest),
    };
    match (section, subsection, variable) {
        ("filter", Some(_), "clean" | "smudge" | "process") => true,
        ("diff", None, "external") => true,
        ("diff", Some(_), "textconv" | "command") => true,
        ("core", None, "fsmonitor") => !is_boolean(value),
        (
            "core",
            None,
            "pager" | "sshcommand" | "editor" | "askpass" | "gitproxy" | "hookspath",
        ) => true,
        ("pager", _, _) => !is_boolean(value),
        ("alias", _, _) => true,
        ("gpg", _, "program") => true,
        _ => false,
    }
}

/// Whether `git config -z --show-scope --get-regexp` output holds an entry
/// from the repository's own scopes (local, worktree, includes followed) that
/// names a command. `Err` when the output cannot be read, which callers treat
/// as a yes.
pub(crate) fn config_names_commands(raw: &[u8]) -> Result<bool, String> {
    let text = std::str::from_utf8(raw)
        .map_err(|_| "This repository's git config could not be read.".to_string())?;
    let mut parts = text.split('\0');
    while let Some(scope) = parts.next() {
        let Some(entry) = parts.next() else { break };
        if !matches!(scope, "local" | "worktree") {
            continue;
        }
        let (key, value) = match entry.split_once('\n') {
            Some((key, value)) => (key, Some(value)),
            None => (entry, None),
        };
        if entry_names_command(key, value) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Hooks git runs on a read: `git status` and `git diff` may write the index
/// on their own, which runs `post-index-change`.
const READ_HOOKS: &[&str] = &["post-index-change"];

/// Whether a read-only git command run in `cwd` could run a command the
/// repository itself names: a filter or diff driver, `core.fsmonitor`, a
/// pager, an alias, a gpg program, a hooks path, or a hook git runs when it
/// refreshes the index. `Err` when git could not answer, which callers treat
/// as a yes.
pub(crate) fn repo_names_commands(cwd: &Path) -> Result<bool, String> {
    let output = plain_git()
        .args(["-c", "core.fsmonitor=false", "-C"])
        .arg(cwd)
        .args([
            "config",
            "-z",
            "--includes",
            "--show-scope",
            "--get-regexp",
            r"^(filter|diff|core|pager|alias|gpg)\.",
        ])
        .output()
        .map_err(|error| error.to_string())?;
    match output.status.code() {
        Some(0) => {
            if config_names_commands(&output.stdout)? {
                return Ok(true);
            }
        }
        Some(1) => {}
        _ => return Err("git could not read this repository's config.".into()),
    }
    for hook in READ_HOOKS {
        let output = plain_git()
            .args(["-c", "core.fsmonitor=false", "-C"])
            .arg(cwd)
            .args(["rev-parse", "--git-path"])
            .arg(format!("hooks/{hook}"))
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            // Not inside a repository: git reads no repository config there.
            continue;
        }
        let path = String::from_utf8(output.stdout)
            .map_err(|_| "git printed a hooks path that is not text.".to_string())?;
        let path = Path::new(path.trim_end_matches(['\n', '\r']));
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            cwd.join(path)
        };
        if std::fs::symlink_metadata(&path).is_ok() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether the repository at `cwd` names a command a read-only git command
/// would run, so a git rule must not answer for it without the card. Read
/// only: runs `git config` and `git rev-parse`, nothing the repository names.
#[tauri::command]
pub async fn git_repo_names_commands(cwd: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&cwd);
        if !path.is_absolute() || !path.is_dir() {
            return Err("The chat's folder is not a folder.".to_string());
        }
        repo_names_commands(path)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Where git looks for hooks when none should run.
#[cfg(windows)]
const NO_HOOKS: &str = "core.hooksPath=NUL";
#[cfg(not(windows))]
const NO_HOOKS: &str = "core.hooksPath=/dev/null";

/// The `-c` value that keeps hooks off, for callers that build their own
/// command.
pub(crate) const NO_HOOKS_ARG: &str = NO_HOOKS;

/// Subcommands that recurse into submodules, whose own config this guard
/// does not read. They get `--ignore-submodules=dirty` (security review, F3).
const SUBMODULE_READS: &[&str] = &["diff", "status"];

/// How far a call is held.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Reads are held; writes keep the repository's filters and hooks, for a
    /// commit or a stage the user clicked.
    Auto,
    /// Everything is held, writes included: MonoCode's own snapshots, taken
    /// after every turn with no click (security review, F1).
    Everything,
}

/// Global options to put before the subcommand, and the subcommand's own
/// arguments, for one call MonoCode makes in `root`. `Err` means the call must
/// not run.
pub(crate) fn guard(root: &Path, args: &[&str]) -> Result<(Vec<String>, Vec<String>), String> {
    guard_with(root, args, Mode::Auto, &[])
}

/// `guard` for calls MonoCode makes on its own that also write, such as the
/// turn checkpoint's private index: no repository filter, driver or hook runs.
/// The snapshot then holds the files as they are on disk, and a restore
/// through the same guard writes them back as they were.
#[cfg(test)]
pub(crate) fn guard_everything(
    root: &Path,
    args: &[&str],
) -> Result<(Vec<String>, Vec<String>), String> {
    guard_with(root, args, Mode::Everything, &[])
}

/// `guard_everything` for a call pinned to one repository by `GIT_DIR`,
/// `GIT_WORK_TREE` and `GIT_CEILING_DIRECTORIES`: the config is read from
/// that same repository, never one found again from `root`.
pub(crate) fn guard_everything_pinned(
    root: &Path,
    args: &[&str],
    envs: &[(&str, &std::ffi::OsStr)],
) -> Result<(Vec<String>, Vec<String>), String> {
    guard_with(root, args, Mode::Everything, envs)
}

fn guard_with(
    root: &Path,
    args: &[&str],
    mode: Mode,
    envs: &[(&str, &std::ffi::OsStr)],
) -> Result<(Vec<String>, Vec<String>), String> {
    let mut globals = vec!["-c".to_string(), "core.fsmonitor=false".to_string()];
    let mut rest: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
    if subcommand(args).is_none() || (mode == Mode::Auto && is_write(args)) {
        return Ok((globals, rest));
    }
    globals.extend(override_args(&repo_drivers(root, envs)?));
    globals.extend([
        "-c".to_string(),
        "log.showSignature=false".to_string(),
        "-c".to_string(),
        NO_HOOKS.to_string(),
    ]);
    if let Some(sub) = subcommand(args) {
        let mut inserted = Vec::new();
        if DIFFS.contains(&sub) && !args.contains(&"--no-ext-diff") {
            inserted.push("--no-ext-diff".to_string());
        }
        if SUBMODULE_READS.contains(&sub)
            && !args
                .iter()
                .any(|arg| arg.starts_with("--ignore-submodules"))
        {
            inserted.push("--ignore-submodules=dirty".to_string());
        }
        if let Some(at) = rest.iter().position(|arg| arg == sub) {
            for (offset, arg) in inserted.into_iter().enumerate() {
                rest.insert(at + 1 + offset, arg);
            }
        }
    }
    Ok((globals, rest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Repo(PathBuf);
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn run(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    fn repo(name: &str) -> Repo {
        let dir = std::env::temp_dir().join(format!(
            "monocode-git-guard-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        run(&dir, &["init", "-q"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        run(&dir, &["add", "a.txt"]);
        run(&dir, &["commit", "-qm", "init"]);
        Repo(dir)
    }

    fn guarded(root: &Path, args: &[&str]) -> std::process::Output {
        let (globals, rest) = guard(root, args).unwrap();
        Command::new("git")
            .args(&globals)
            .arg("-C")
            .arg(root)
            .args(&rest)
            .output()
            .unwrap()
    }

    /// Writes a filter and a diff driver that each leave a marker, named from
    /// `.git/info/attributes`, which `--attr-source` does not cover.
    fn plant(root: &Path) -> (PathBuf, PathBuf) {
        let clean = root.with_extension("clean-ran");
        let textconv = root.with_extension("textconv-ran");
        std::fs::create_dir_all(root.join(".git/info")).unwrap();
        std::fs::write(root.join(".git/info/attributes"), "* filter=mark diff=mk\n").unwrap();
        run(
            root,
            &[
                "config",
                "filter.mark.clean",
                &format!("touch '{}'; cat", clean.display()),
            ],
        );
        run(
            root,
            &[
                "config",
                "diff.mk.textconv",
                &format!("touch '{}'; cat", textconv.display()),
            ],
        );
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        (clean, textconv)
    }

    #[test]
    fn plain_git_runs_the_planted_commands() {
        // Proves the planted commands are real, so the guarded test cannot
        // pass without doing anything.
        let repo = repo("plain");
        let (clean, textconv) = plant(&repo.0);
        let out = Command::new("git")
            .arg("-C")
            .arg(&repo.0)
            .args(["diff", "HEAD"])
            .output()
            .unwrap();
        assert!(out.status.success());
        assert!(
            clean.exists(),
            "the clean filter should run under plain git"
        );
        assert!(textconv.exists(), "the textconv should run under plain git");
        let _ = std::fs::remove_file(clean);
        let _ = std::fs::remove_file(textconv);
    }

    #[test]
    fn polling_reads_never_run_a_filter_or_textconv_named_in_the_repo() {
        let repo = repo("guarded");
        let (clean, textconv) = plant(&repo.0);
        for args in [
            &[
                "diff",
                "--relative",
                "--no-ext-diff",
                "--numstat",
                "HEAD",
                "--",
                ".",
            ][..],
            &["diff", "--name-status", "--no-renames", "HEAD"][..],
            &["diff", "--name-only", "--no-renames"][..],
            &["diff", "HEAD", "--", "a.txt"][..],
            &["status", "--porcelain=v1", "-z"][..],
            &["log", "-p", "-1"][..],
            &["ls-files", "-m"][..],
        ] {
            let out = guarded(&repo.0, args);
            assert!(
                out.status.success(),
                "{args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        assert!(!clean.exists(), "a read ran the repository's clean filter");
        assert!(!textconv.exists(), "a read ran the repository's textconv");
        let numstat = guarded(&repo.0, &["diff", "--numstat", "HEAD"]);
        assert_eq!(String::from_utf8_lossy(&numstat.stdout), "1\t0\ta.txt\n");
        let patch = guarded(&repo.0, &["diff", "HEAD"]);
        assert!(String::from_utf8_lossy(&patch.stdout).contains("+two"));
    }

    #[test]
    fn a_filter_from_an_included_config_file_is_switched_off_too() {
        let repo = repo("include");
        let marker = repo.0.with_extension("include-ran");
        let extra = repo.0.join(".git/extra.cfg");
        std::fs::write(
            &extra,
            format!(
                "[filter \"inc\"]\n\tclean = touch '{}'; cat\n",
                marker.display()
            ),
        )
        .unwrap();
        run(&repo.0, &["config", "include.path", "extra.cfg"]);
        std::fs::write(repo.0.join(".gitattributes"), "* filter=inc\n").unwrap();
        std::fs::write(repo.0.join("a.txt"), "changed\n").unwrap();
        let out = guarded(&repo.0, &["diff", "--numstat", "HEAD"]);
        assert!(out.status.success());
        assert!(!marker.exists(), "an included filter ran");
    }

    #[test]
    fn writes_keep_the_filters_and_never_get_overrides() {
        let repo = repo("write");
        let (globals, rest) = guard(&repo.0, &["add", "--", "a.txt"]).unwrap();
        assert_eq!(globals, ["-c", "core.fsmonitor=false"]);
        assert_eq!(rest, ["add", "--", "a.txt"]);
        let (globals, _) = guard(&repo.0, &["--literal-pathspecs", "commit", "-m", "x"]).unwrap();
        assert_eq!(globals.len(), 2);
    }

    #[test]
    fn diff_gets_no_ext_diff_once() {
        let repo = repo("extdiff");
        let (_, rest) = guard(&repo.0, &["diff", "HEAD"]).unwrap();
        assert_eq!(
            rest,
            ["diff", "--no-ext-diff", "--ignore-submodules=dirty", "HEAD"]
        );
        let (_, rest) = guard(&repo.0, &["diff", "--no-ext-diff", "HEAD"]).unwrap();
        assert_eq!(
            rest,
            ["diff", "--ignore-submodules=dirty", "--no-ext-diff", "HEAD"]
        );
        let (_, rest) = guard(&repo.0, &["--literal-pathspecs", "show", "HEAD"]).unwrap();
        assert_eq!(
            rest,
            ["--literal-pathspecs", "show", "--no-ext-diff", "HEAD"]
        );
    }

    #[test]
    fn parse_keeps_only_the_repositorys_own_scopes() {
        let raw = b"system\0filter.lfs.clean\ngit-lfs clean -- %f\0local\0filter.mark.clean\nevil\0worktree\0diff.a.b.textconv\nx\0global\0diff.img.textconv\nexif\0local\0filter.mark.smudge\ny\0";
        let drivers = parse_repo_drivers(raw).unwrap();
        assert_eq!(drivers.filters, ["mark"]);
        assert_eq!(drivers.diffs, ["a.b"]);
    }

    #[test]
    fn a_name_that_cannot_be_passed_back_refuses_the_read() {
        let raw = b"local\0filter.a=b.clean\nx\0";
        assert!(parse_repo_drivers(raw).is_err());
        let raw = b"local\0filter.a\x1bb.clean\nx\0";
        assert!(parse_repo_drivers(raw).is_err());
    }

    #[test]
    fn subcommand_skips_global_options() {
        assert_eq!(
            subcommand(&["-c", "x=y", "-C", "/tmp", "diff"]),
            Some("diff")
        );
        assert_eq!(
            subcommand(&["--literal-pathspecs", "status"]),
            Some("status")
        );
        assert_eq!(subcommand(&["--version"]), None);
    }

    #[test]
    fn a_driver_name_that_is_not_utf8_refuses_the_read() {
        let raw = b"local\0filter.\xff.clean\nx\0";
        assert!(parse_repo_drivers(raw).is_err());
    }

    #[test]
    fn the_checkpoint_add_runs_no_filter_and_no_hook() {
        let repo = repo("everything");
        let (clean, _) = plant(&repo.0);
        let hook_marker = repo.0.with_extension("hook-ran");
        let hooks = repo.0.join(".git/hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("reference-transaction");
        std::fs::write(
            &hook,
            format!("#!/bin/sh\ntouch '{}'\n", hook_marker.display()),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let index = repo.0.with_extension("index");
        for args in [
            &["add", "-A", "--", "."][..],
            &["update-ref", "refs/monocode/test", "HEAD"][..],
        ] {
            let (globals, rest) = guard_everything(&repo.0, args).unwrap();
            let out = Command::new("git")
                .args(&globals)
                .arg("-C")
                .arg(&repo.0)
                .args(&rest)
                .env("GIT_INDEX_FILE", &index)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        assert!(!clean.exists(), "the checkpoint's add ran the clean filter");
        assert!(
            !hook_marker.exists(),
            "the checkpoint ran a repository hook"
        );
        // A user's own commit still gets the repository's hooks.
        let (globals, _) = guard(&repo.0, &["commit", "-m", "x"]).unwrap();
        assert!(!globals.iter().any(|arg| arg.starts_with("core.hooksPath")));
        let _ = std::fs::remove_file(index);
    }

    #[test]
    fn a_submodules_own_filter_does_not_run_on_a_read() {
        let parent = repo("parent");
        let sub = parent.0.join("s");
        std::fs::create_dir_all(&sub).unwrap();
        run(&sub, &["init", "-q"]);
        std::fs::write(sub.join("a.txt"), "x\n").unwrap();
        run(&sub, &["add", "a.txt"]);
        run(&sub, &["commit", "-qm", "s"]);
        // A gitlink, as an agent could make with a nested repository.
        run(&parent.0, &["add", "s"]);
        run(&parent.0, &["commit", "-qm", "add s"]);
        let marker = parent.0.with_extension("sub-ran");
        run(
            &sub,
            &[
                "config",
                "filter.sf.clean",
                &format!("touch '{}'; cat", marker.display()),
            ],
        );
        std::fs::create_dir_all(sub.join(".git/info")).unwrap();
        std::fs::write(sub.join(".git/info/attributes"), "* filter=sf\n").unwrap();
        // Same content, new time: git has to look again.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(sub.join("a.txt"), "x\n").unwrap();
        for args in [
            &["status", "--porcelain=v1", "-z"][..],
            &["diff", "--numstat", "HEAD"][..],
        ] {
            let out = guarded(&parent.0, args);
            assert!(out.status.success());
        }
        assert!(!marker.exists(), "a read ran a submodule's own filter");
    }

    fn plain_repo(name: &str) -> Repo {
        let dir = std::env::temp_dir().join(format!(
            "monocode-git-names-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        run(&dir, &["init", "-q"]);
        Repo(dir)
    }

    #[test]
    fn a_repository_with_no_commands_in_its_config_passes() {
        // A repository with no commits, as the user often has.
        let repo = plain_repo("clean");
        assert_eq!(repo_names_commands(&repo.0), Ok(false));
        for (key, value) in [
            ("core.fsmonitor", "false"),
            ("pager.log", "false"),
            ("diff.algorithm", "patience"),
            ("diff.md.binary", "true"),
            ("filter.lfs.required", "true"),
        ] {
            run(&repo.0, &["config", key, value]);
        }
        assert_eq!(repo_names_commands(&repo.0), Ok(false));
    }

    #[test]
    fn each_command_the_repository_names_is_found() {
        for (key, value) in [
            ("core.fsmonitor", "touch /tmp/x"),
            ("core.pager", "less"),
            ("pager.log", "sh -c id"),
            ("diff.external", "sh -c id"),
            ("diff.md.textconv", "sh -c id"),
            ("diff.md.command", "sh -c id"),
            ("filter.f.clean", "sh -c id"),
            ("filter.f.smudge", "sh -c id"),
            ("filter.f.process", "sh -c id"),
            ("core.sshCommand", "sh -c id"),
            ("core.hooksPath", "hooks"),
            ("alias.lg", "!sh -c id"),
            ("gpg.program", "sh"),
            ("gpg.ssh.program", "sh"),
        ] {
            let repo = plain_repo("named");
            run(&repo.0, &["config", key, value]);
            assert_eq!(repo_names_commands(&repo.0), Ok(true), "{key}");
        }
    }

    #[test]
    fn a_command_in_an_included_file_is_found() {
        let repo = plain_repo("include");
        let extra = repo.0.join("extra.cfg");
        std::fs::write(&extra, "[diff]\n\texternal = sh -c id\n").unwrap();
        run(
            &repo.0,
            &["config", "include.path", extra.to_str().unwrap()],
        );
        assert_eq!(repo_names_commands(&repo.0), Ok(true));
    }

    #[test]
    fn a_read_hook_is_found_from_a_subfolder() {
        let repo = plain_repo("hook");
        let sub = repo.0.join("sub dir");
        std::fs::create_dir_all(&sub).unwrap();
        assert_eq!(repo_names_commands(&sub), Ok(false));
        std::fs::create_dir_all(repo.0.join(".git/hooks")).unwrap();
        std::fs::write(
            repo.0.join(".git/hooks/post-index-change"),
            "#!/bin/sh\nid\n",
        )
        .unwrap();
        assert_eq!(repo_names_commands(&sub), Ok(true));
    }

    #[test]
    fn a_folder_that_is_not_a_repository_names_nothing() {
        let dir = std::env::temp_dir().join(format!(
            "monocode-git-names-none-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let guard = Repo(dir.clone());
        // Only meaningful when the temp folder is not itself in a repository.
        let inside = plain_git()
            .args(["-C"])
            .arg(&dir)
            .args(["rev-parse", "--git-dir"])
            .output()
            .unwrap();
        if !inside.status.success() {
            assert_eq!(repo_names_commands(&guard.0), Ok(false));
        }
    }

    #[test]
    fn only_the_repositorys_own_scopes_count() {
        let raw =
            b"global\0alias.lg\nlog --oneline\0system\0core.pager\nless\0local\0core.bare\nfalse\0";
        assert_eq!(config_names_commands(raw), Ok(false));
        let raw = b"global\0alias.lg\nx\0worktree\0alias.st\nstatus\0";
        assert_eq!(config_names_commands(raw), Ok(true));
        // A valueless boolean entry has no newline.
        assert_eq!(config_names_commands(b"local\0pager.log\0"), Ok(false));
        assert!(config_names_commands(b"local\0alias.\xff\nx\0").is_err());
    }

    #[test]
    fn english_sets_the_c_locale() {
        let mut command = Command::new("git");
        english(&mut command);
        let envs: Vec<_> = command.get_envs().collect();
        assert!(envs.contains(&(
            std::ffi::OsStr::new("LC_ALL"),
            Some(std::ffi::OsStr::new("C"))
        )));
        assert!(envs.contains(&(
            std::ffi::OsStr::new("LANGUAGE"),
            Some(std::ffi::OsStr::new(""))
        )));
    }

    #[test]
    fn plain_git_reads_in_english() {
        let command = plain_git();
        let envs: Vec<_> = command.get_envs().collect();
        assert!(envs.contains(&(
            std::ffi::OsStr::new("LC_ALL"),
            Some(std::ffi::OsStr::new("C"))
        )));
        assert!(envs.contains(&(
            std::ffi::OsStr::new("LANGUAGE"),
            Some(std::ffi::OsStr::new(""))
        )));
    }
}
