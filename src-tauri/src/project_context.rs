//! What MonoCode tells an agent outside the user's words (F2, #27, #36):
//! global instructions, private notes per project, project memory, and the
//! preamble file Claude Code reads at launch. All of it lives in the app's
//! data folder, never in the repository, and every write goes through a fixed
//! list of file names, so no input can name a path of its own.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const ROOT_DIR: &str = "context";
const PROJECTS_DIR: &str = "projects";
const PREAMBLE_DIR: &str = "preamble";
/// The project's path, kept beside its files so the folder can be told apart.
const PROJECT_FILE: &str = "project.txt";

/// Files a global scope may hold.
const GLOBAL_FILES: &[&str] = &["instructions.md"];
/// Files a project scope may hold.
const PROJECT_FILES: &[&str] = &[
    "notes.md",
    "MEMORY.md",
    "archive.md",
    "proposals.json",
    "automation-proposals.json",
];

/// Instructions and memory are short text. A cap keeps a bad caller from
/// filling the disk.
const MAX_FILE_BYTES: usize = 256 * 1024;
const MAX_PREAMBLE_BYTES: usize = 64 * 1024;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextFile {
    pub text: Option<String>,
    /// Hash of the text, or of "" when the file does not exist yet. A save
    /// over it must name this hash.
    pub hash: String,
}

pub fn content_hash(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The folder for one project: a hash of its path, so the path cannot
/// steer where anything is written.
fn project_dir(root: &Path, project: &str) -> Result<PathBuf, String> {
    let project = project.trim();
    if project.is_empty() || project.len() > 4096 || project.contains('\0') {
        return Err("Invalid project path".into());
    }
    if !Path::new(project).is_absolute() {
        return Err("The project path must be absolute".into());
    }
    let key: String = content_hash(project).chars().take(32).collect();
    Ok(root.join(PROJECTS_DIR).join(key))
}

fn file_path(
    root: &Path,
    scope: &str,
    project: Option<&str>,
    file: &str,
) -> Result<(PathBuf, Option<String>), String> {
    match scope {
        "global" => {
            if !GLOBAL_FILES.contains(&file) {
                return Err(format!("Not a context file: {file}"));
            }
            Ok((root.join(file), None))
        }
        "project" => {
            if !PROJECT_FILES.contains(&file) {
                return Err(format!("Not a context file: {file}"));
            }
            let project = project.ok_or("A project is required")?;
            Ok((
                project_dir(root, project)?.join(file),
                Some(project.trim().to_string()),
            ))
        }
        _ => Err(format!("Unknown scope: {scope}")),
    }
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Owner-only, written beside the target and renamed over it, so a crash
/// mid-write leaves the old file whole. Memory can hold personal details.
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let mut temp = path.as_os_str().to_owned();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut out = options
        .open(&temp)
        .map_err(|e| format!("{}: {e}", temp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        out.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("{}: {e}", temp.display()))?;
    }
    out.write_all(text.as_bytes())
        .map_err(|e| format!("{}: {e}", temp.display()))?;
    drop(out);
    std::fs::rename(&temp, path).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn read(
    root: &Path,
    scope: &str,
    project: Option<&str>,
    file: &str,
) -> Result<ContextFile, String> {
    let (path, _) = file_path(root, scope, project, file)?;
    let text = read_optional(&path)?;
    let hash = content_hash(text.as_deref().unwrap_or(""));
    Ok(ContextFile { text, hash })
}

/// Saves over `expected_hash`. Errors with "conflict" when the file moved
/// since it was read, so two windows cannot overwrite each other.
pub fn save(
    root: &Path,
    scope: &str,
    project: Option<&str>,
    file: &str,
    text: &str,
    expected_hash: Option<&str>,
) -> Result<String, String> {
    if text.len() > MAX_FILE_BYTES {
        return Err(format!("{file} is over {} KB", MAX_FILE_BYTES / 1024));
    }
    let (path, project_path) = file_path(root, scope, project, file)?;
    if let Some(expected) = expected_hash {
        let current = read_optional(&path)?;
        if content_hash(current.as_deref().unwrap_or("")) != expected {
            return Err("conflict".into());
        }
    }
    write_atomic(&path, text)?;
    if let (Some(project_path), Some(dir)) = (project_path, path.parent()) {
        let marker = dir.join(PROJECT_FILE);
        if read_optional(&marker)?.as_deref() != Some(project_path.as_str()) {
            write_atomic(&marker, &project_path)?;
        }
    }
    Ok(content_hash(text))
}

/// A session id names a file, so it is held to letters, digits, - and _.
fn preamble_path(root: &Path, session_id: &str) -> Result<PathBuf, String> {
    let valid = !session_id.is_empty()
        && session_id.len() <= 128
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if !valid {
        return Err("Invalid session id".into());
    }
    Ok(root.join(PREAMBLE_DIR).join(format!("{session_id}.md")))
}

pub fn write_preamble(root: &Path, session_id: &str, text: &str) -> Result<String, String> {
    if text.len() > MAX_PREAMBLE_BYTES {
        return Err("The session preamble is too long".into());
    }
    let path = preamble_path(root, session_id)?;
    write_atomic(&path, text)?;
    Ok(path.to_string_lossy().into_owned())
}

pub fn forget_preamble(root: &Path, session_id: &str) -> Result<(), String> {
    let path = preamble_path(root, session_id)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn context_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(ROOT_DIR))
}

#[tauri::command]
pub async fn project_context_read(
    app: AppHandle,
    scope: String,
    project: Option<String>,
    file: String,
) -> Result<ContextFile, String> {
    let root = context_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || read(&root, &scope, project.as_deref(), &file))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn project_context_save(
    app: AppHandle,
    scope: String,
    project: Option<String>,
    file: String,
    text: String,
    expected_hash: Option<String>,
) -> Result<String, String> {
    let root = context_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        save(
            &root,
            &scope,
            project.as_deref(),
            &file,
            &text,
            expected_hash.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Writes the preamble Claude Code reads with `--append-system-prompt-file`
/// and returns its path. Scoped to the app's data folder: unlike
/// `fs::write_text_file`, it cannot write anywhere else.
#[tauri::command]
pub async fn session_preamble_write(
    app: AppHandle,
    session_id: String,
    text: String,
) -> Result<String, String> {
    let root = context_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || write_preamble(&root, &session_id, &text))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_preamble_forget(app: AppHandle, session_id: String) -> Result<(), String> {
    let root = context_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || forget_preamble(&root, &session_id))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("context-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn reads_a_missing_file_as_empty_with_the_empty_hash() {
        let root = temp_root();
        let file = read(&root, "global", None, "instructions.md").unwrap();
        assert_eq!(file.text, None);
        assert_eq!(file.hash, content_hash(""));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn saves_per_project_and_refuses_a_stale_hash() {
        let root = temp_root();
        let hash = save(
            &root,
            "project",
            Some("/code/app"),
            "notes.md",
            "a",
            Some(&content_hash("")),
        )
        .unwrap();
        assert_eq!(
            read(&root, "project", Some("/code/app"), "notes.md")
                .unwrap()
                .text
                .as_deref(),
            Some("a")
        );
        // Another project is separate.
        assert_eq!(
            read(&root, "project", Some("/code/other"), "notes.md")
                .unwrap()
                .text,
            None
        );
        assert_eq!(
            save(
                &root,
                "project",
                Some("/code/app"),
                "notes.md",
                "b",
                Some(&content_hash(""))
            ),
            Err("conflict".into())
        );
        save(
            &root,
            "project",
            Some("/code/app"),
            "notes.md",
            "b",
            Some(&hash),
        )
        .unwrap();
        // The folder records which project it belongs to.
        let dir = project_dir(&root, "/code/app").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join(PROJECT_FILE)).unwrap(),
            "/code/app"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn names_no_path_of_its_own() {
        let root = temp_root();
        for file in ["../x.md", "/etc/passwd", "MEMORY.md/../../x", "soul.md", ""] {
            assert!(
                read(&root, "project", Some("/code/app"), file).is_err(),
                "{file}"
            );
            assert!(
                save(&root, "project", Some("/code/app"), file, "x", None).is_err(),
                "{file}"
            );
        }
        assert!(read(&root, "global", None, "MEMORY.md").is_err());
        assert!(read(&root, "elsewhere", None, "instructions.md").is_err());
        // Automation proposals (#39) are a project file, never a global one.
        assert!(save(
            &root,
            "project",
            Some("/code/app"),
            "automation-proposals.json",
            "[]",
            None
        )
        .is_ok());
        assert!(read(&root, "global", None, "automation-proposals.json").is_err());
        assert!(read(
            &root,
            "project",
            Some("/code/app"),
            "automation-proposals.json/../x"
        )
        .is_err());
        // Relative or empty project paths are refused; a path with .. only
        // changes the hash, never the folder.
        assert!(read(&root, "project", Some("code/app"), "notes.md").is_err());
        assert!(read(&root, "project", Some(""), "notes.md").is_err());
        assert!(read(&root, "project", None, "notes.md").is_err());
        let dir = project_dir(&root, "/code/../../etc").unwrap();
        assert!(dir.starts_with(root.join(PROJECTS_DIR)));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn caps_the_size_of_a_file() {
        let root = temp_root();
        let big = "x".repeat(MAX_FILE_BYTES + 1);
        assert!(save(&root, "global", None, "instructions.md", &big, None).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn writes_the_preamble_only_under_its_own_folder() {
        let root = temp_root();
        let path = write_preamble(&root, "session-1_a", "Hello").unwrap();
        assert!(Path::new(&path).starts_with(root.join(PREAMBLE_DIR)));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "Hello");
        for bad in ["", "../x", "a/b", "a b", "x.md", &"a".repeat(129)] {
            assert!(write_preamble(&root, bad, "x").is_err(), "{bad}");
        }
        assert!(write_preamble(&root, "s", &"x".repeat(MAX_PREAMBLE_BYTES + 1)).is_err());
        forget_preamble(&root, "session-1_a").unwrap();
        assert!(!Path::new(&path).exists());
        // Forgetting twice is fine.
        forget_preamble(&root, "session-1_a").unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_root();
        save(
            &root,
            "project",
            Some("/code/app"),
            "MEMORY.md",
            "- x",
            None,
        )
        .unwrap();
        let dir = project_dir(&root, "/code/app").unwrap();
        let mode = std::fs::metadata(dir.join("MEMORY.md"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        std::fs::remove_dir_all(root).unwrap();
    }
}
