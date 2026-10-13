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
//! alone. Writes (`add`, `commit`, `checkout` and the like) keep the filters,
//! because a filter shapes what is stored, and run only on the user's click.

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
    let text = String::from_utf8_lossy(raw);
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

fn repo_drivers(root: &Path) -> Result<RepoDrivers, String> {
    let mut command = Command::new("git");
    crate::hide_window_console(&mut command);
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
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| error.to_string())?;
    // Exit 1 means no key matched.
    match output.status.code() {
        Some(0) => parse_repo_drivers(&output.stdout),
        Some(1) => Ok(RepoDrivers::default()),
        _ => Err("git could not read this repository's config.".into()),
    }
}

/// Global options to put before the subcommand, and the subcommand's own
/// arguments, for one call MonoCode makes in `root`. `Err` means the call must
/// not run.
pub(crate) fn guard(root: &Path, args: &[&str]) -> Result<(Vec<String>, Vec<String>), String> {
    let mut globals = vec!["-c".to_string(), "core.fsmonitor=false".to_string()];
    let mut rest: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
    if is_write(args) || subcommand(args).is_none() {
        return Ok((globals, rest));
    }
    globals.extend(override_args(&repo_drivers(root)?));
    globals.extend(["-c".to_string(), "log.showSignature=false".to_string()]);
    if let Some(sub) = subcommand(args) {
        if DIFFS.contains(&sub) && !args.contains(&"--no-ext-diff") {
            if let Some(at) = rest.iter().position(|arg| arg == sub) {
                rest.insert(at + 1, "--no-ext-diff".to_string());
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
        assert_eq!(rest, ["diff", "--no-ext-diff", "HEAD"]);
        let (_, rest) = guard(&repo.0, &["diff", "--no-ext-diff", "HEAD"]).unwrap();
        assert_eq!(rest, ["diff", "--no-ext-diff", "HEAD"]);
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
}
