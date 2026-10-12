//! #28: environment variables a harness starts with, global and per project.
//!
//! Plain values live in `<app data>/context/env.json` (owner-only). A value
//! marked secret lives in the OS keychain, through the `keyring` crate
//! MonoCode already uses, and never comes back to the interface: the editor
//! can replace or remove it, not read it. Nothing here logs a value.
//!
//! Values are applied in `harness_spawn`, after the GUI environment and
//! before the provider account, which still removes the API key variables.
//! Names MonoCode or the loader depend on are refused.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

const FILE: &str = "env.json";
const KEYCHAIN_SERVICE: &str = "MonoCode environment";
const MAX_VALUE_BYTES: usize = 32 * 1024;
const MAX_VARS: usize = 200;

/// Names a harness or MonoCode itself depends on. Setting one could point a
/// harness at another home, load code into it, or put back an API key a
/// provider account removes on purpose (corner case 12).
const RESERVED: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "USERPROFILE",
    "PWD",
    "OLDPWD",
    "TMPDIR",
    "CODEX_HOME",
    "CODEX_SQLITE_HOME",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "NODE_OPTIONS",
];
const RESERVED_PREFIXES: &[&str] = &["MONOCODE_", "DYLD_", "LD_"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct StoredVar {
    pub name: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub secret: bool,
    /// Absent for a secret: its value is in the keychain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct EnvFile {
    #[serde(default)]
    pub global: Vec<StoredVar>,
    #[serde(default)]
    pub projects: BTreeMap<String, Vec<StoredVar>>,
}

/// What the editor sees: a secret's value never leaves this module.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VarView {
    pub name: String,
    pub secret: bool,
    pub value: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvView {
    pub global: Vec<VarView>,
    pub projects: BTreeMap<String, Vec<VarView>>,
}

/// Where secret values are kept. The keychain in the app, a map in tests.
pub trait SecretStore {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn remove(&self, key: &str) -> Result<(), String>;
}

pub struct Keychain;

impl SecretStore for Keychain {
    fn get(&self, key: &str) -> Option<String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, key)
            .ok()?
            .get_password()
            .ok()
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, key)
            .and_then(|entry| entry.set_password(value))
            .map_err(|_| "Could not save the value in the keychain".to_string())
    }
    fn remove(&self, key: &str) -> Result<(), String> {
        match keyring::Entry::new(KEYCHAIN_SERVICE, key).and_then(|entry| entry.delete_credential())
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Could not remove the value from the keychain".into()),
        }
    }
}

pub fn check_name(name: &str) -> Result<(), String> {
    let valid = !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !valid {
        return Err("A name is letters, digits and _, and does not start with a digit".into());
    }
    let upper = name.to_ascii_uppercase();
    if RESERVED.contains(&upper.as_str())
        || RESERVED_PREFIXES
            .iter()
            .any(|prefix| upper.starts_with(prefix))
    {
        return Err(format!(
            "{name} is reserved: MonoCode, the harness or its provider account sets it. API keys belong under Providers."
        ));
    }
    Ok(())
}

fn check_value(value: &str) -> Result<(), String> {
    if value.contains('\0') {
        return Err("A value cannot contain a NUL character".into());
    }
    if value.len() > MAX_VALUE_BYTES {
        return Err(format!("A value is at most {} KB", MAX_VALUE_BYTES / 1024));
    }
    Ok(())
}

fn check_project(project: &str) -> Result<String, String> {
    let project = project.trim();
    if project.is_empty() || project.contains('\0') || !Path::new(project).is_absolute() {
        return Err("The project path must be absolute".into());
    }
    Ok(project.to_string())
}

/// The keychain entry for one secret: the scope, then the name.
fn secret_key(project: Option<&str>, name: &str) -> String {
    match project {
        None => format!("global/{name}"),
        Some(project) => {
            let hash = crate::project_context::content_hash(project);
            format!("project/{}/{name}", &hash[..32])
        }
    }
}

pub fn load_file(path: &Path) -> EnvFile {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_file(path: &Path, file: &EnvFile) -> Result<(), String> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut out = options.open(&temp).map_err(|e| e.to_string())?;
    out.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    drop(out);
    std::fs::rename(&temp, path).map_err(|e| e.to_string())
}

fn view_of(vars: &[StoredVar]) -> Vec<VarView> {
    vars.iter()
        .map(|var| VarView {
            name: var.name.clone(),
            secret: var.secret,
            value: if var.secret { None } else { var.value.clone() },
        })
        .collect()
}

pub fn view(file: &EnvFile) -> EnvView {
    EnvView {
        global: view_of(&file.global),
        projects: file
            .projects
            .iter()
            .map(|(path, vars)| (path.clone(), view_of(vars)))
            .collect(),
    }
}

pub fn set_var(
    path: &Path,
    secrets: &dyn SecretStore,
    project: Option<&str>,
    name: &str,
    value: &str,
    secret: bool,
) -> Result<(), String> {
    check_name(name)?;
    check_value(value)?;
    let project = project.map(check_project).transpose()?;
    let mut file = load_file(path);
    let vars = match &project {
        None => &mut file.global,
        Some(project) => file.projects.entry(project.clone()).or_default(),
    };
    let existing = vars.iter().position(|var| var.name == name);
    if existing.is_none() && vars.len() >= MAX_VARS {
        return Err(format!("At most {MAX_VARS} variables per scope"));
    }
    let key = secret_key(project.as_deref(), name);
    if secret {
        secrets.set(&key, value)?;
    } else if existing.is_some_and(|index| vars[index].secret) {
        // Was a secret, now plain: do not leave the old value behind.
        secrets.remove(&key)?;
    }
    let stored = StoredVar {
        name: name.to_string(),
        secret,
        value: if secret {
            None
        } else {
            Some(value.to_string())
        },
    };
    match existing {
        Some(index) => vars[index] = stored,
        None => vars.push(stored),
    }
    save_file(path, &file)
}

pub fn remove_var(
    path: &Path,
    secrets: &dyn SecretStore,
    project: Option<&str>,
    name: &str,
) -> Result<(), String> {
    let project = project.map(check_project).transpose()?;
    let mut file = load_file(path);
    let vars = match &project {
        None => &mut file.global,
        Some(project) => match file.projects.get_mut(project) {
            Some(vars) => vars,
            None => return Ok(()),
        },
    };
    let Some(index) = vars.iter().position(|var| var.name == name) else {
        return Ok(());
    };
    if vars[index].secret {
        secrets.remove(&secret_key(project.as_deref(), name))?;
    }
    vars.remove(index);
    if let Some(project) = &project {
        if file.projects.get(project).is_some_and(Vec::is_empty) {
            file.projects.remove(project);
        }
    }
    save_file(path, &file)
}

/// The main checkout of a git worktree: its `.git` file names
/// `<main>/.git/worktrees/<name>`. Read, never run.
///
/// The `.git` file alone is not trusted: an agent or an unpacked archive can
/// write one naming any project. Git's own back-link must agree:
/// `<main>/.git/worktrees/<name>/gitdir` must name this folder's `.git`.
fn main_checkout(dir: &Path) -> Option<PathBuf> {
    let dot_git_file = dir.join(".git");
    if !std::fs::symlink_metadata(&dot_git_file).ok()?.is_file() {
        return None;
    }
    let text = std::fs::read_to_string(&dot_git_file).ok()?;
    let gitdir = text
        .lines()
        .find_map(|line| line.strip_prefix("gitdir:"))?
        .trim();
    // Git 2.48 can write relative links: the `.git` file's path is relative
    // to the worktree folder, and the back-link is relative to the gitdir.
    let gitdir = dir.join(gitdir);
    // The check uses resolved paths; the project key keeps the path as written.
    let resolved = std::fs::canonicalize(&gitdir).ok()?;
    let back = std::fs::read_to_string(resolved.join("gitdir")).ok()?;
    let back = std::fs::canonicalize(resolved.join(back.trim())).ok()?;
    if back != std::fs::canonicalize(&dot_git_file).ok()? {
        return None;
    }
    let gitdir = lexical_normal(&gitdir);
    let worktrees = gitdir.parent()?;
    if worktrees.file_name()? != "worktrees" {
        return None;
    }
    let dot_git = worktrees.parent()?;
    if dot_git.file_name()? != ".git" {
        return None;
    }
    Some(dot_git.parent()?.to_path_buf())
}

/// `a/b/../c` as `a/c`, without touching the disk, so a relative worktree link
/// still names its main checkout the way the project was stored.
fn lexical_normal(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The stored project a working folder belongs to: the folder itself or the
/// nearest folder above it, or for a worktree, its main checkout's project.
pub fn project_for(file: &EnvFile, workdir: &Path) -> Option<String> {
    let find = |start: &Path| {
        start.ancestors().find_map(|dir| {
            let key = dir.to_string_lossy();
            file.projects
                .contains_key(key.as_ref())
                .then(|| key.into_owned())
        })
    };
    find(workdir).or_else(|| {
        workdir
            .ancestors()
            .find_map(main_checkout)
            .and_then(|main| find(&main))
    })
}

/// The variables for a child started in `workdir`: global first, then the
/// project's, which win. Secrets missing from the keychain are left out.
pub fn resolve(file: &EnvFile, secrets: &dyn SecretStore, workdir: &Path) -> Vec<(String, String)> {
    resolve_with(file, Some(secrets), workdir)
}

/// The plain values only, never a secret: for a process that runs the
/// project's own code outside the sandbox, such as a preview server (#37).
/// Code an agent edits there could send its environment anywhere.
pub fn resolve_plain(file: &EnvFile, workdir: &Path) -> Vec<(String, String)> {
    resolve_with(file, None, workdir)
}

fn resolve_with(
    file: &EnvFile,
    secrets: Option<&dyn SecretStore>,
    workdir: &Path,
) -> Vec<(String, String)> {
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    let mut add = |project: Option<&str>, vars: &[StoredVar]| {
        for var in vars {
            // A file edited by hand is checked again.
            if check_name(&var.name).is_err() {
                continue;
            }
            let value = if var.secret {
                secrets.and_then(|store| store.get(&secret_key(project, &var.name)))
            } else {
                var.value.clone()
            };
            if let Some(value) = value.filter(|value| check_value(value).is_ok()) {
                out.insert(var.name.clone(), value);
            }
        }
    };
    add(None, &file.global);
    if let Some(project) = project_for(file, workdir) {
        if let Some(vars) = file.projects.get(&project) {
            add(Some(&project), vars);
        }
    }
    out.into_iter().collect()
}

fn env_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("context")
        .join(FILE))
}

/// Called by `harness_spawn`. Never fails the spawn: a store that cannot be
/// read gives no variables.
pub fn apply_to_child(app: &AppHandle, cmd: &mut Command, workdir: &Path) {
    let Ok(path) = env_path(app) else { return };
    let file = load_file(&path);
    if file.global.is_empty() && file.projects.is_empty() {
        return;
    }
    for (name, value) in resolve(&file, &Keychain, workdir) {
        cmd.env(name, value);
    }
}

/// For a process MonoCode starts to run the project's code, such as a
/// preview server: the editor's plain values, never its secrets, and the
/// keychain is not read at all.
pub fn apply_plain_to_child(app: &AppHandle, cmd: &mut Command, workdir: &Path) {
    let Ok(path) = env_path(app) else { return };
    let file = load_file(&path);
    if file.global.is_empty() && file.projects.is_empty() {
        return;
    }
    for (name, value) in resolve_plain(&file, workdir) {
        cmd.env(name, value);
    }
}

#[tauri::command]
pub async fn env_store_load(app: AppHandle) -> Result<EnvView, String> {
    let path = env_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || Ok(view(&load_file(&path))))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn env_store_set(
    app: AppHandle,
    project: Option<String>,
    name: String,
    value: String,
    secret: bool,
) -> Result<(), String> {
    let path = env_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        set_var(&path, &Keychain, project.as_deref(), &name, &value, secret)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn env_store_remove(
    app: AppHandle,
    project: Option<String>,
    name: String,
) -> Result<(), String> {
    let path = env_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        remove_var(&path, &Keychain, project.as_deref(), &name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Memory(RefCell<HashMap<String, String>>);
    impl SecretStore for Memory {
        fn get(&self, key: &str) -> Option<String> {
            self.0.borrow().get(key).cloned()
        }
        fn set(&self, key: &str, value: &str) -> Result<(), String> {
            self.0.borrow_mut().insert(key.into(), value.into());
            Ok(())
        }
        fn remove(&self, key: &str) -> Result<(), String> {
            self.0.borrow_mut().remove(key);
            Ok(())
        }
    }

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("env-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn refuses_reserved_and_malformed_names() {
        for name in [
            "PATH",
            "path",
            "HOME",
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "CODEX_HOME",
            "MONOCODE_APP_TOKEN",
            "DYLD_INSERT_LIBRARIES",
            "LD_PRELOAD",
            "NODE_OPTIONS",
            "",
            "1ABC",
            "A-B",
            "A B",
            "A=B",
            "ÄB",
        ] {
            assert!(check_name(name).is_err(), "{name}");
        }
        for name in ["DATABASE_URL", "_X", "gh_token2"] {
            assert!(check_name(name).is_ok(), "{name}");
        }
    }

    #[test]
    fn keeps_plain_values_in_the_file_and_secrets_in_the_store() {
        let dir = temp();
        let path = dir.join(FILE);
        let secrets = Memory::default();
        set_var(&path, &secrets, None, "REGION", "eu", false).unwrap();
        set_var(
            &path,
            &secrets,
            Some("/code/app"),
            "DB_PASSWORD",
            "hunter2",
            true,
        )
        .unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("eu"));
        assert!(!text.contains("hunter2"), "a secret reached the file");
        let shown = view(&load_file(&path));
        assert_eq!(shown.global[0].value.as_deref(), Some("eu"));
        let project = &shown.projects["/code/app"][0];
        assert!(project.secret);
        assert_eq!(project.value, None, "a secret went back to the interface");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_preview_gets_plain_values_and_never_a_secret() {
        let dir = temp();
        let path = dir.join(FILE);
        let secrets = Memory::default();
        let project = dir.join("app");
        std::fs::create_dir_all(&project).unwrap();
        let key = project.to_string_lossy().into_owned();
        set_var(&path, &secrets, None, "REGION", "eu", false).unwrap();
        set_var(&path, &secrets, None, "GITHUB_TOKEN", "ghp_x", true).unwrap();
        set_var(&path, &secrets, Some(&key), "API_URL", "http://x", false).unwrap();
        set_var(&path, &secrets, Some(&key), "DB_PASSWORD", "hunter2", true).unwrap();
        let file = load_file(&path);
        let all = resolve(&file, &secrets, &project);
        assert!(all.iter().any(|(name, _)| name == "GITHUB_TOKEN"));
        assert!(all.iter().any(|(name, _)| name == "DB_PASSWORD"));
        let plain = resolve_plain(&file, &project);
        let names: Vec<&str> = plain.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, vec!["API_URL", "REGION"]);
        assert!(plain
            .iter()
            .all(|(_, value)| value != "ghp_x" && value != "hunter2"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn resolves_global_then_project_and_follows_worktrees() {
        let dir = temp();
        let path = dir.join(FILE);
        let secrets = Memory::default();
        let main = dir.join("app");
        let worktree = dir.join("app-wt");
        std::fs::create_dir_all(main.join(".git/worktrees/wt")).unwrap();
        std::fs::create_dir_all(worktree.join("src")).unwrap();
        std::fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", main.join(".git/worktrees/wt").display()),
        )
        .unwrap();
        // Git's back-link from the main checkout to this worktree.
        std::fs::write(
            main.join(".git/worktrees/wt/gitdir"),
            format!("{}\n", worktree.join(".git").display()),
        )
        .unwrap();
        let project = main.to_string_lossy().into_owned();
        set_var(&path, &secrets, None, "REGION", "eu", false).unwrap();
        set_var(&path, &secrets, None, "SHARED", "global", false).unwrap();
        set_var(&path, &secrets, Some(&project), "SHARED", "project", false).unwrap();
        set_var(&path, &secrets, Some(&project), "TOKEN", "s3cret", true).unwrap();
        let file = load_file(&path);
        let expect = vec![
            ("REGION".to_string(), "eu".to_string()),
            ("SHARED".to_string(), "project".to_string()),
            ("TOKEN".to_string(), "s3cret".to_string()),
        ];
        assert_eq!(resolve(&file, &secrets, &main.join("src")), expect);
        assert_eq!(resolve(&file, &secrets, &worktree.join("src")), expect);
        // Another folder gets the global ones only.
        assert_eq!(
            resolve(&file, &secrets, &dir.join("elsewhere")),
            vec![
                ("REGION".to_string(), "eu".to_string()),
                ("SHARED".to_string(), "global".to_string())
            ]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn follows_a_worktree_written_with_relative_links() {
        let dir = temp();
        let path = dir.join(FILE);
        let secrets = Memory::default();
        let main = dir.join("app");
        let worktree = dir.join("app-wt");
        std::fs::create_dir_all(main.join(".git/worktrees/wt")).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(worktree.join(".git"), "gitdir: ../app/.git/worktrees/wt\n").unwrap();
        std::fs::write(
            main.join(".git/worktrees/wt/gitdir"),
            "../../../../app-wt/.git\n",
        )
        .unwrap();
        let project = main.to_string_lossy().into_owned();
        set_var(&path, &secrets, Some(&project), "REGION", "eu", false).unwrap();
        let file = load_file(&path);
        assert_eq!(
            resolve(&file, &secrets, &worktree),
            vec![("REGION".to_string(), "eu".to_string())]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_forged_git_file_does_not_reach_another_projects_values() {
        let dir = temp();
        let path = dir.join(FILE);
        let secrets = Memory::default();
        let main = dir.join("secret-proj");
        std::fs::create_dir_all(main.join(".git/worktrees/x")).unwrap();
        let project = main.to_string_lossy().into_owned();
        set_var(&path, &secrets, Some(&project), "TOKEN", "s3cret", true).unwrap();
        let file = load_file(&path);
        // A folder with a `.git` file naming the project, and no back-link.
        let forged = dir.join("downloads");
        std::fs::create_dir_all(&forged).unwrap();
        std::fs::write(
            forged.join(".git"),
            format!("gitdir: {}\n", main.join(".git/worktrees/x").display()),
        )
        .unwrap();
        assert!(resolve(&file, &secrets, &forged).is_empty());
        // A back-link that names a different worktree does not count either.
        let real = dir.join("real-wt");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join(".git"), "gitdir: elsewhere\n").unwrap();
        std::fs::write(
            main.join(".git/worktrees/x/gitdir"),
            format!("{}\n", real.join(".git").display()),
        )
        .unwrap();
        assert!(resolve(&file, &secrets, &forged).is_empty());
        // A gitdir path that does not exist gives nothing.
        std::fs::write(forged.join(".git"), "gitdir: /no/such/.git/worktrees/x\n").unwrap();
        assert!(resolve(&file, &secrets, &forged).is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn skips_names_reserved_in_a_hand_edited_file_and_lost_secrets() {
        let dir = temp();
        let path = dir.join(FILE);
        std::fs::write(
            &path,
            r#"{"global":[{"name":"PATH","value":"/evil"},{"name":"OK","value":"1"},{"name":"GONE","secret":true}]}"#,
        )
        .unwrap();
        assert_eq!(
            resolve(&load_file(&path), &Memory::default(), &dir),
            vec![("OK".to_string(), "1".to_string())]
        );
        // A broken file gives nothing rather than failing a spawn.
        std::fs::write(&path, "{not json").unwrap();
        assert!(resolve(&load_file(&path), &Memory::default(), &dir).is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn removes_values_and_their_secrets() {
        let dir = temp();
        let path = dir.join(FILE);
        let secrets = Memory::default();
        set_var(&path, &secrets, Some("/code/app"), "TOKEN", "x", true).unwrap();
        assert_eq!(secrets.0.borrow().len(), 1);
        // Turning a secret into a plain value drops the stored secret.
        set_var(&path, &secrets, Some("/code/app"), "TOKEN", "plain", false).unwrap();
        assert!(secrets.0.borrow().is_empty());
        set_var(&path, &secrets, Some("/code/app"), "TOKEN", "x", true).unwrap();
        remove_var(&path, &secrets, Some("/code/app"), "TOKEN").unwrap();
        assert!(secrets.0.borrow().is_empty());
        assert!(load_file(&path).projects.is_empty());
        // Removing what is not there is fine.
        remove_var(&path, &secrets, None, "NOPE").unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_bad_values_and_paths() {
        let dir = temp();
        let path = dir.join(FILE);
        let secrets = Memory::default();
        assert!(set_var(&path, &secrets, None, "A", "x\0y", false).is_err());
        assert!(set_var(
            &path,
            &secrets,
            None,
            "A",
            &"x".repeat(MAX_VALUE_BYTES + 1),
            false
        )
        .is_err());
        assert!(set_var(&path, &secrets, Some("relative/path"), "A", "x", false).is_err());
        // A value may hold shell syntax; it is passed as data, never run.
        set_var(&path, &secrets, None, "A", "$(rm -rf ~); `x`", false).unwrap();
        assert_eq!(
            resolve(&load_file(&path), &secrets, &dir),
            vec![("A".to_string(), "$(rm -rf ~); `x`".to_string())]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
