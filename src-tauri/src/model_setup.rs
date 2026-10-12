//! Model setup: finds model servers on this machine and writes a Codex home
//! for one provider into a named Codex account folder.
//!
//! - Detection probes fixed loopback ports only (`127.0.0.1`), with redirects
//!   off and a short timeout. Nothing leaves the machine.
//! - The writer builds `config.toml` from typed fields with the `toml` crate,
//!   so no value can break out of its string. It writes three files with
//!   fixed names into `provider-accounts/codex/<account>/` and nothing else.
//!   Analytics are off in every home it writes. No key is ever written: a
//!   hosted provider names the environment variable that holds its key.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const MAX_INSTRUCTIONS: usize = 64 * 1024;
const MAX_CATALOG: usize = 512 * 1024;
const MAX_MODEL: usize = 200;
const PROBE_TIMEOUT: Duration = Duration::from_millis(800);
const MAX_PROBE_BODY: u64 = 256 * 1024;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedServer {
    pub kind: String,
    pub base_url: String,
    pub models: Vec<String>,
}

/// Fixed probes: (kind, port). Each answers the OpenAI-style `/v1/models`.
const PROBES: &[(&str, u16)] = &[
    ("ollama", 11434),
    ("lmstudio", 1234),
    ("llamacpp", 8080),
    ("vllm", 8000),
];

fn probe_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(PROBE_TIMEOUT)
        .redirects(0)
        .try_proxy_from_env(false)
        .build()
}

/// Model ids from an OpenAI-style `/v1/models` body.
pub(crate) fn parse_model_list(body: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let Some(items) = value.get("data").and_then(|data| data.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| item.get("id").and_then(|id| id.as_str()))
        .filter(|id| valid_model(id))
        .take(100)
        .map(str::to_string)
        .collect()
}

#[tauri::command(async)]
pub fn model_setup_detect() -> Vec<DetectedServer> {
    let agent = probe_agent();
    let mut found = Vec::new();
    for (kind, port) in PROBES {
        let base_url = format!("http://127.0.0.1:{port}/v1");
        let Ok(response) = agent.get(&format!("{base_url}/models")).call() else {
            continue;
        };
        let mut body = String::new();
        if response
            .into_reader()
            .take(MAX_PROBE_BODY)
            .read_to_string(&mut body)
            .is_err()
        {
            continue;
        }
        found.push(DetectedServer {
            kind: (*kind).to_string(),
            base_url,
            models: parse_model_list(&body),
        });
    }
    found
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexHomeSpec {
    pub account_id: String,
    pub provider_id: String,
    pub provider_name: String,
    pub base_url: String,
    pub model: String,
    pub context_window: Option<u64>,
    pub env_key: Option<String>,
    pub instructions: String,
    pub catalog: serde_json::Value,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WrittenHome {
    pub dir: String,
    pub files: Vec<String>,
    /// A config.toml that was already there, kept beside the new one.
    pub backup: Option<String>,
}

fn valid_account(id: &str) -> bool {
    id != "default"
        && !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub(crate) fn valid_provider(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && id != "openai"
}

fn valid_model(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_MODEL
        && !id
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace() || matches!(ch, '"' | '\'' | '\\'))
}

fn valid_env_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_uppercase() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
}

/// An http(s) URL with a host and no user name or password.
pub(crate) fn valid_base_url(value: &str) -> Option<url::Url> {
    let url = url::Url::parse(value.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    url.host_str()?;
    Some(url)
}

/// Checks the spec and returns the trimmed base URL.
pub(crate) fn validate_spec(spec: &CodexHomeSpec) -> Result<String, String> {
    if !valid_account(&spec.account_id) {
        return Err("Invalid account id".into());
    }
    if !valid_provider(&spec.provider_id) {
        return Err("Invalid provider id".into());
    }
    if !valid_model(&spec.model) {
        return Err("Invalid model name".into());
    }
    let name = spec.provider_name.trim();
    if name.is_empty() || name.len() > 80 || name.chars().any(char::is_control) {
        return Err("Invalid provider name".into());
    }
    if let Some(window) = spec.context_window {
        if !(1_024..=10_000_000).contains(&window) {
            return Err("Context window out of range".into());
        }
    }
    if let Some(key) = &spec.env_key {
        if !valid_env_key(key) {
            return Err("Invalid environment variable name".into());
        }
    }
    if spec.instructions.len() > MAX_INSTRUCTIONS {
        return Err("Instructions are too long".into());
    }
    let url = valid_base_url(&spec.base_url).ok_or("Invalid base URL")?;
    validate_catalog(&spec.catalog, &spec.model)?;
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn validate_catalog(catalog: &serde_json::Value, model: &str) -> Result<(), String> {
    let models = catalog
        .get("models")
        .and_then(|models| models.as_array())
        .ok_or("Catalog has no models list")?;
    if models.len() != 1 {
        return Err("Catalog must hold exactly one model".into());
    }
    let slug = models[0].get("slug").and_then(|slug| slug.as_str());
    if slug != Some(model) {
        return Err("Catalog slug does not match the model".into());
    }
    let size = serde_json::to_string(catalog)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_CATALOG {
        return Err("Catalog is too large".into());
    }
    Ok(())
}

/// The config.toml text for a spec, given the absolute paths of the other two files.
pub(crate) fn render_config(
    spec: &CodexHomeSpec,
    base_url: &str,
    catalog_path: &Path,
    instructions_path: &Path,
) -> Result<String, String> {
    use toml::{Table, Value};
    let mut root = Table::new();
    root.insert(
        "model_provider".into(),
        Value::String(spec.provider_id.clone()),
    );
    root.insert("model".into(), Value::String(spec.model.clone()));
    if let Some(window) = spec.context_window {
        root.insert("model_context_window".into(), Value::Integer(window as i64));
    }
    root.insert(
        "model_catalog_json".into(),
        Value::String(catalog_path.to_string_lossy().into_owned()),
    );
    root.insert(
        "model_instructions_file".into(),
        Value::String(instructions_path.to_string_lossy().into_owned()),
    );
    root.insert("check_for_update_on_startup".into(), Value::Boolean(false));

    let mut provider = Table::new();
    provider.insert(
        "name".into(),
        Value::String(spec.provider_name.trim().to_string()),
    );
    provider.insert("base_url".into(), Value::String(base_url.to_string()));
    provider.insert("wire_api".into(), Value::String("responses".into()));
    provider.insert("requires_openai_auth".into(), Value::Boolean(false));
    provider.insert("supports_websockets".into(), Value::Boolean(false));
    provider.insert("stream_idle_timeout_ms".into(), Value::Integer(300_000));
    if let Some(key) = &spec.env_key {
        provider.insert("env_key".into(), Value::String(key.clone()));
    }
    let mut providers = Table::new();
    providers.insert(spec.provider_id.clone(), Value::Table(provider));
    root.insert("model_providers".into(), Value::Table(providers));

    let mut analytics = Table::new();
    analytics.insert("enabled".into(), Value::Boolean(false));
    root.insert("analytics".into(), Value::Table(analytics));

    let mut otel = Table::new();
    otel.insert("exporter".into(), Value::String("none".into()));
    otel.insert("metrics_exporter".into(), Value::String("none".into()));
    root.insert("otel".into(), Value::Table(otel));

    let body = toml::to_string(&root).map_err(|error| error.to_string())?;
    Ok(format!(
        "# Written by MonoCode's model setup. Analytics are off.\n{body}"
    ))
}

fn refuse_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(format!(
            "Refusing to write through a link: {}",
            path.display()
        )),
        _ => Ok(()),
    }
}

/// Writes one file through a temporary file and a rename, never through a link.
fn write_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    refuse_symlink(path)?;
    let tmp = path.with_extension("monocode-tmp");
    refuse_symlink(&tmp)?;
    let mut file = fs::File::create(&tmp).map_err(|error| error.to_string())?;
    file.write_all(contents)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    fs::rename(&tmp, path).map_err(|error| error.to_string())
}

/// Writes the three files into `dir`. Split out of the command for tests.
pub(crate) fn write_home(dir: &Path, spec: &CodexHomeSpec) -> Result<WrittenHome, String> {
    let base_url = validate_spec(spec)?;
    refuse_symlink(dir)?;
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    refuse_symlink(dir)?;
    let config_path = dir.join("config.toml");
    let catalog_path = dir.join("catalog.json");
    let instructions_path = dir.join("instructions.md");

    let mut backup = None;
    if config_path.exists() {
        refuse_symlink(&config_path)?;
        let existing = fs::read(&config_path).map_err(|error| error.to_string())?;
        if !existing.starts_with(b"# Written by MonoCode's model setup.") {
            let backup_path = dir.join("config.toml.monocode-backup");
            write_file(&backup_path, &existing)?;
            backup = Some(backup_path.to_string_lossy().into_owned());
        }
    }

    let catalog = serde_json::to_vec_pretty(&spec.catalog).map_err(|error| error.to_string())?;
    write_file(&catalog_path, &catalog)?;
    write_file(&instructions_path, spec.instructions.as_bytes())?;
    let config = render_config(spec, &base_url, &catalog_path, &instructions_path)?;
    write_file(&config_path, config.as_bytes())?;

    Ok(WrittenHome {
        dir: dir.to_string_lossy().into_owned(),
        files: vec![
            config_path.to_string_lossy().into_owned(),
            catalog_path.to_string_lossy().into_owned(),
            instructions_path.to_string_lossy().into_owned(),
        ],
        backup,
    })
}

fn account_dir(app: &AppHandle, account_id: &str) -> Result<PathBuf, String> {
    if !valid_account(account_id) {
        return Err("Invalid account id".into());
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("provider-accounts")
        .join("codex")
        .join(account_id))
}

#[tauri::command(async)]
pub fn model_setup_write_codex_home(
    app: AppHandle,
    spec: CodexHomeSpec,
) -> Result<WrittenHome, String> {
    let dir = account_dir(&app, &spec.account_id)?;
    write_home(&dir, &spec)
}

// Approvals held to a chat's folders (lane 5, part 2). It lives here because
// lane 5 owns no other Rust file in this wave; session 6 may move it.

const MAX_APPROVAL_PATHS: usize = 256;

/// The canonical form of `path`, resolving every symlink on the way. A path
/// that does not exist yet is the canonical form of its nearest existing
/// ancestor plus the missing names, taken literally. A dangling symlink, a
/// `..` or `.` component, or a relative path gives `None`.
fn resolve_for_approval(path: &Path) -> Option<PathBuf> {
    use std::path::Component;
    if !path.is_absolute() {
        return None;
    }
    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return None;
    }
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        match fs::symlink_metadata(&current) {
            Ok(_) => {
                // Exists, or is a link: canonicalize follows it, and fails on
                // a link that points nowhere.
                let mut resolved = fs::canonicalize(&current).ok()?;
                for name in missing.iter().rev() {
                    resolved.push(name);
                }
                return Some(resolved);
            }
            Err(_) => {
                let name = current.file_name()?.to_os_string();
                missing.push(name);
                if !current.pop() {
                    return None;
                }
            }
        }
    }
}

/// True only when every path resolves inside one of the roots. Roots must
/// exist and be folders. The filesystem root is never accepted as a root.
pub fn paths_within(roots: &[String], paths: &[String]) -> bool {
    if roots.is_empty() || paths.is_empty() || paths.len() > MAX_APPROVAL_PATHS {
        return false;
    }
    let mut canonical_roots = Vec::new();
    for root in roots {
        let root_path = Path::new(root);
        let Some(resolved) = resolve_for_approval(root_path) else {
            return false;
        };
        if !resolved.is_dir() || resolved.parent().is_none() {
            return false;
        }
        canonical_roots.push(resolved);
    }
    paths.iter().all(|path| {
        resolve_for_approval(Path::new(path)).is_some_and(|resolved| {
            canonical_roots
                .iter()
                .any(|root| resolved.starts_with(root))
        })
    })
}

#[tauri::command]
pub fn approval_paths_within(roots: Vec<String>, paths: Vec<String>) -> bool {
    paths_within(&roots, &paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> CodexHomeSpec {
        CodexHomeSpec {
            account_id: "account-1".into(),
            provider_id: "ollama_local".into(),
            provider_name: "Ollama".into(),
            base_url: "http://127.0.0.1:11434/v1/".into(),
            model: "qwen2.5:7b".into(),
            context_window: Some(16_384),
            env_key: None,
            instructions: "Edit files with apply_patch through exec_command.".into(),
            catalog: serde_json::json!({ "models": [{ "slug": "qwen2.5:7b" }] }),
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "monocode-model-setup-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn writes_three_files_with_analytics_off() {
        let dir = temp_dir("write");
        let written = write_home(&dir, &spec()).unwrap();
        assert_eq!(written.files.len(), 3);
        assert!(written.backup.is_none());
        let config = fs::read_to_string(dir.join("config.toml")).unwrap();
        let parsed: toml::Table = toml::from_str(&config).unwrap();
        assert_eq!(parsed["model_provider"].as_str(), Some("ollama_local"));
        assert_eq!(parsed["model_context_window"].as_integer(), Some(16_384));
        assert_eq!(parsed["analytics"]["enabled"].as_bool(), Some(false));
        let provider = &parsed["model_providers"]["ollama_local"];
        assert_eq!(
            provider["base_url"].as_str(),
            Some("http://127.0.0.1:11434/v1")
        );
        assert_eq!(provider["requires_openai_auth"].as_bool(), Some(false));
        assert!(provider.get("env_key").is_none());
        // Top-level keys sit above the first table, as Codex needs.
        let first_table = config.find('[').unwrap();
        assert!(config.find("model_instructions_file").unwrap() < first_table);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn keeps_a_hand_written_config_as_a_backup() {
        let dir = temp_dir("backup");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("config.toml"), "model = \"mine\"\n").unwrap();
        let written = write_home(&dir, &spec()).unwrap();
        assert!(written.backup.is_some());
        assert_eq!(
            fs::read_to_string(dir.join("config.toml.monocode-backup")).unwrap(),
            "model = \"mine\"\n"
        );
        // A second write replaces our own file and keeps the first backup.
        let again = write_home(&dir, &spec()).unwrap();
        assert!(again.backup.is_none());
        assert_eq!(
            fs::read_to_string(dir.join("config.toml.monocode-backup")).unwrap(),
            "model = \"mine\"\n"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn values_cannot_break_out_of_the_toml() {
        let dir = temp_dir("escape");
        let mut bad = spec();
        bad.provider_name = "x\"\n[model_providers.evil]\nbase_url = \"http://evil".into();
        assert!(
            write_home(&dir, &bad).is_err(),
            "control characters are refused"
        );
        let mut quoted = spec();
        quoted.provider_name = "a \"quoted\" ] name".into();
        write_home(&dir, &quoted).unwrap();
        let parsed: toml::Table =
            toml::from_str(&fs::read_to_string(dir.join("config.toml")).unwrap()).unwrap();
        assert_eq!(parsed["model_providers"].as_table().unwrap().len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_bad_specs() {
        let dir = temp_dir("refuse");
        type Change = Box<dyn Fn(&mut CodexHomeSpec)>;
        let cases: Vec<Change> = vec![
            Box::new(|s| s.account_id = "../x".into()),
            Box::new(|s| s.account_id = "default".into()),
            Box::new(|s| s.provider_id = "-c".into()),
            Box::new(|s| s.provider_id = "openai".into()),
            Box::new(|s| s.model = "a b".into()),
            Box::new(|s| s.base_url = "file:///etc/passwd".into()),
            Box::new(|s| s.base_url = "http://user:pw@127.0.0.1/".into()),
            Box::new(|s| s.env_key = Some("lower".into())),
            Box::new(|s| s.context_window = Some(5)),
            Box::new(|s| s.instructions = "x".repeat(MAX_INSTRUCTIONS + 1)),
            Box::new(|s| s.catalog = serde_json::json!({ "models": [{ "slug": "other" }] })),
            Box::new(|s| s.catalog = serde_json::json!({ "models": [] })),
        ];
        for change in cases {
            let mut bad = spec();
            change(&mut bad);
            assert!(write_home(&dir, &bad).is_err());
        }
        assert!(!dir.exists(), "nothing is written for a refused spec");
    }

    #[cfg(unix)]
    #[test]
    fn never_writes_through_a_link() {
        let dir = temp_dir("link");
        let target = temp_dir("link-target");
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(&target).unwrap();
        std::os::unix::fs::symlink(target.join("elsewhere"), dir.join("config.toml")).unwrap();
        assert!(write_home(&dir, &spec()).is_err());
        assert!(!target.join("elsewhere").exists());
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&target).unwrap();
    }

    #[test]
    fn hosted_provider_names_its_key_variable_only() {
        let dir = temp_dir("hosted");
        let mut hosted = spec();
        hosted.provider_id = "openrouter".into();
        hosted.base_url = "https://openrouter.ai/api/v1".into();
        hosted.env_key = Some("OPENROUTER_API_KEY".into());
        write_home(&dir, &hosted).unwrap();
        let config = fs::read_to_string(dir.join("config.toml")).unwrap();
        assert!(config.contains("env_key = \"OPENROUTER_API_KEY\""));
        assert!(!config.contains("sk-"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_model_lists() {
        assert_eq!(
            parse_model_list(r#"{"data":[{"id":"qwen2.5:7b"},{"id":"bad id"},{"x":1}]}"#),
            vec!["qwen2.5:7b".to_string()]
        );
        assert!(parse_model_list("<html>").is_empty());
        assert!(parse_model_list(r#"{"data":"no"}"#).is_empty());
    }
    #[cfg(unix)]
    mod approval_paths {
        use super::super::paths_within;
        use std::fs;
        use std::os::unix::fs::symlink;

        fn tmp(name: &str) -> std::path::PathBuf {
            let dir =
                std::env::temp_dir().join(format!("mc-approval-{}-{}", name, std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            dir
        }

        fn s(p: &std::path::Path) -> String {
            p.to_string_lossy().into_owned()
        }

        #[test]
        fn inside_and_new_files() {
            let root = tmp("inside");
            fs::write(root.join("a.txt"), "x").unwrap();
            let roots = vec![s(&root)];
            assert!(paths_within(&roots, &[s(&root.join("a.txt"))]));
            assert!(paths_within(&roots, &[s(&root.join("new/dir/b.txt"))]));
            assert!(paths_within(
                &roots,
                &[s(&root.join("name with spaces.txt"))]
            ));
            assert!(paths_within(&roots, &[s(&root.join("-leading-dash"))]));
        }

        #[test]
        fn outside_dotdot_relative_and_root() {
            let root = tmp("outside");
            let other = tmp("other");
            let roots = vec![s(&root)];
            assert!(!paths_within(&roots, &[s(&other.join("x"))]));
            assert!(!paths_within(&roots, &[format!("{}/../x", s(&root))]));
            assert!(!paths_within(&roots, &["relative.txt".into()]));
            assert!(!paths_within(&roots, &[]));
            assert!(!paths_within(&[], &[s(&root.join("a"))]));
            assert!(!paths_within(&["/".into()], &["/etc/hosts".into()]));
            // A sibling whose name starts with the root's name is not inside.
            let sibling = format!("{}-evil/x", s(&root));
            assert!(!paths_within(&roots, &[sibling]));
        }

        #[test]
        fn symlink_escapes() {
            let root = tmp("links");
            let other = tmp("target");
            fs::write(other.join("secret"), "x").unwrap();
            symlink(&other, root.join("out")).unwrap();
            symlink(other.join("secret"), root.join("file-link")).unwrap();
            symlink(root.join("nowhere"), root.join("dangling")).unwrap();
            let roots = vec![s(&root)];
            assert!(!paths_within(&roots, &[s(&root.join("out/new.txt"))]));
            assert!(!paths_within(&roots, &[s(&root.join("file-link"))]));
            assert!(!paths_within(&roots, &[s(&root.join("dangling"))]));
            // A link inside that stays inside is fine.
            fs::create_dir_all(root.join("real")).unwrap();
            symlink(root.join("real"), root.join("alias")).unwrap();
            assert!(paths_within(&roots, &[s(&root.join("alias/x"))]));
        }

        #[test]
        fn root_given_through_a_symlink() {
            let real = tmp("real-root");
            let link_parent = tmp("link-parent");
            symlink(&real, link_parent.join("proj")).unwrap();
            let roots = vec![s(&link_parent.join("proj"))];
            assert!(paths_within(&roots, &[s(&real.join("a"))]));
            assert!(paths_within(&roots, &[s(&link_parent.join("proj/a"))]));
        }
    }
}
