//! #37 and #38a: the preview pane and verify after edits.
//!
//! MonoCode starts a project's dev server itself, on the PTY backend, after
//! the user has seen and confirmed the command. This module holds the parts
//! that need Rust:
//!
//! - Reading `.claude/launch.json` and `package.json` from the project root,
//!   refusing a link that leads outside it.
//! - Resolving a configuration's working folder inside the project.
//! - A free loopback port, for configurations that ask for one.
//! - The probe: one GET on the preview URL, loopback only, no redirects, that
//!   reports the status and whether the page refuses to be framed.
//!
//! Every URL is parsed with `url::Url`. `harness::assert_loopback` is not used:
//! it is a prefix check, so `http://localhost:@other.host/` passes it. Here the
//! connection itself can only reach 127.0.0.0/8 or ::1, whatever a name
//! resolves to.

use std::fs;
use std::io::{self, Read};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use url::{Host, Url};

/// Largest configuration file read, in bytes.
pub const MAX_CONFIG_BYTES: u64 = 256 * 1024;
/// Lockfiles that tell which package manager a project uses.
const LOCKFILES: &[&str] = &[
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "bun.lock",
];
/// Bytes of a probed page read before the connection is dropped.
const PROBE_BODY_BYTES: u64 = 16 * 1024;
const PROBE_CONNECT: Duration = Duration::from_secs(3);
const PROBE_READ: Duration = Duration::from_secs(8);

#[derive(Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewConfigFiles {
    /// `.claude/launch.json`, when present and inside the project.
    pub launch_json: Option<String>,
    /// `package.json`, when present and inside the project.
    pub package_json: Option<String>,
    /// The project's `.npmrc`, when present and inside the project. npm reads
    /// it when it runs a script, so the webview hashes it into the preview's
    /// fingerprint. Never shown: it can hold a registry token.
    pub npmrc: Option<String>,
    /// The lockfiles found at the root, by name.
    pub lockfiles: Vec<String>,
    /// Files that were present but not read, with the reason.
    pub skipped: Vec<String>,
}

#[derive(Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewProbe {
    /// The HTTP status, when the server answered.
    pub status: Option<u16>,
    /// The page refuses to be shown in a frame.
    pub frame_blocked: bool,
    /// The header that refuses it, for the banner.
    pub frame_reason: Option<String>,
    /// Why there is no status: refused, timed out, not loopback.
    pub error: Option<String>,
}

/// A canonical project root, or an error a person can read.
fn project_root(root: &str) -> Result<PathBuf, String> {
    let path = Path::new(root);
    if root.is_empty() || !path.is_absolute() {
        return Err("The project folder must be an absolute path".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "The project folder does not exist".to_string())?;
    if !canonical.is_dir() {
        return Err("The project folder is not a folder".into());
    }
    Ok(canonical)
}

/// A relative path with no `..`, no root and no prefix. Names are literal.
fn plain_relative(relative: &str) -> Result<PathBuf, String> {
    if relative.contains('\0') {
        return Err("The folder name holds a NUL byte".into());
    }
    let path = Path::new(relative);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("The folder may not use `..`".into());
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("The folder must be inside the project".into());
            }
        }
    }
    Ok(out)
}

/// `relative` inside `root`, after links are followed. A link that leads out
/// is refused.
fn inside(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let joined = root.join(plain_relative(relative)?);
    let canonical = joined
        .canonicalize()
        .map_err(|_| format!("{relative} does not exist in the project"))?;
    if !canonical.starts_with(root) {
        return Err(format!("{relative} leads outside the project"));
    }
    Ok(canonical)
}

fn read_config(root: &Path, relative: &str, skipped: &mut Vec<String>) -> Option<String> {
    let candidate = root.join(relative);
    // Not there at all: nothing to say.
    if fs::symlink_metadata(&candidate).is_err() {
        return None;
    }
    let path = match inside(root, relative) {
        Ok(path) => path,
        Err(reason) => {
            skipped.push(reason);
            return None;
        }
    };
    let meta = match fs::metadata(&path) {
        Ok(meta) if meta.is_file() => meta,
        _ => {
            skipped.push(format!("{relative} is not a file"));
            return None;
        }
    };
    if meta.len() > MAX_CONFIG_BYTES {
        skipped.push(format!("{relative} is larger than 256 KB"));
        return None;
    }
    let mut text = String::new();
    match fs::File::open(&path).and_then(|mut file| {
        file.by_ref()
            .take(MAX_CONFIG_BYTES)
            .read_to_string(&mut text)
    }) {
        Ok(_) => Some(text),
        Err(_) => {
            skipped.push(format!("{relative} could not be read as text"));
            None
        }
    }
}

pub fn read_config_files(root: &str) -> Result<PreviewConfigFiles, String> {
    let root = project_root(root)?;
    let mut skipped = Vec::new();
    let launch_json = read_config(&root, ".claude/launch.json", &mut skipped);
    let package_json = read_config(&root, "package.json", &mut skipped);
    let npmrc = read_config(&root, ".npmrc", &mut skipped);
    let lockfiles = LOCKFILES
        .iter()
        .filter(|name| root.join(name).is_file())
        .map(|name| (*name).to_string())
        .collect();
    Ok(PreviewConfigFiles {
        launch_json,
        package_json,
        npmrc,
        lockfiles,
        skipped,
    })
}

/// The configuration files a preview can start from. Read only.
#[tauri::command]
pub fn preview_read_config(root: String) -> Result<PreviewConfigFiles, String> {
    read_config_files(&root)
}

/// A configuration's working folder, held inside the project.
#[tauri::command]
pub fn preview_resolve_cwd(root: String, relative: String) -> Result<String, String> {
    let root = project_root(&root)?;
    let path = inside(&root, &relative)?;
    if !path.is_dir() {
        return Err(format!("{relative} is not a folder"));
    }
    Ok(path.to_string_lossy().into_owned())
}

/// A port nothing listens on right now, on the loopback address.
#[tauri::command]
pub fn preview_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| e.to_string())
}

fn loopback_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6 == Ipv6Addr::LOCALHOST,
    }
}

/// A preview URL: http or https, a loopback host, no user name or password.
/// `localhost` and its subdomains are not the same thing: only the bare name
/// counts.
pub fn loopback_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "Not a URL".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("A preview is http or https".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("A preview URL may not carry a user name or password".into());
    }
    let local = match url.host() {
        Some(Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => loopback_ip(IpAddr::V4(ip)),
        Some(Host::Ipv6(ip)) => loopback_ip(IpAddr::V6(ip)),
        None => false,
    };
    if !local {
        return Err("A preview runs on this Mac only: localhost, 127.0.0.1 or ::1".into());
    }
    if url.port_or_known_default().is_none() {
        return Err("A preview URL needs a port".into());
    }
    Ok(url)
}

/// Where a loopback URL may connect. A name never reaches a resolver.
fn loopback_addrs(netloc: &str) -> io::Result<Vec<SocketAddr>> {
    let refuse = || io::Error::new(io::ErrorKind::PermissionDenied, "not loopback");
    let (host, port) = netloc.rsplit_once(':').ok_or_else(refuse)?;
    let port: u16 = port.parse().map_err(|_| refuse())?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") {
        return Ok(vec![
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
            SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port),
        ]);
    }
    let ip: IpAddr = host.parse().map_err(|_| refuse())?;
    if !loopback_ip(ip) {
        return Err(refuse());
    }
    Ok(vec![SocketAddr::new(ip, port)])
}

/// Whether these headers keep the page out of a frame on another origin.
pub fn frame_refusal(x_frame_options: Option<&str>, csp: Option<&str>) -> Option<String> {
    if let Some(value) = x_frame_options {
        let value = value.trim();
        // Both values refuse a frame on another origin: the app's own origin is
        // never the preview's.
        if value.eq_ignore_ascii_case("deny") || value.eq_ignore_ascii_case("sameorigin") {
            return Some(format!("X-Frame-Options: {value}"));
        }
    }
    if let Some(policy) = csp {
        for directive in policy.split(';') {
            let mut parts = directive.split_whitespace();
            let Some(name) = parts.next() else { continue };
            if !name.eq_ignore_ascii_case("frame-ancestors") {
                continue;
            }
            let sources: Vec<&str> = parts.collect();
            let open = sources.contains(&"*");
            if !open {
                return Some(format!(
                    "Content-Security-Policy: frame-ancestors {}",
                    sources.join(" ")
                ));
            }
        }
    }
    None
}

fn read_response(response: ureq::Response) -> PreviewProbe {
    let status = response.status();
    let frame_reason = frame_refusal(
        response.header("x-frame-options"),
        response.header("content-security-policy"),
    );
    // Read a little, so a server that streams forever does not hold the probe.
    let mut sink = Vec::new();
    let _ = response
        .into_reader()
        .take(PROBE_BODY_BYTES)
        .read_to_end(&mut sink);
    PreviewProbe {
        status: Some(status),
        frame_blocked: frame_reason.is_some(),
        frame_reason,
        error: None,
    }
}

pub fn probe(raw: &str) -> PreviewProbe {
    let url = match loopback_url(raw) {
        Ok(url) => url,
        Err(error) => {
            return PreviewProbe {
                error: Some(error),
                ..PreviewProbe::default()
            }
        }
    };
    let agent = ureq::AgentBuilder::new()
        .resolver(|netloc: &str| loopback_addrs(netloc))
        .redirects(0)
        .timeout_connect(PROBE_CONNECT)
        .timeout_read(PROBE_READ)
        .user_agent("MonoCode preview check")
        .build();
    match agent.get(url.as_str()).call() {
        Ok(response) => read_response(response),
        Err(ureq::Error::Status(_, response)) => read_response(response),
        Err(ureq::Error::Transport(error)) => PreviewProbe {
            error: Some(error.to_string()),
            ..PreviewProbe::default()
        },
    }
}

/// One GET on a loopback preview URL. Never follows a redirect.
#[tauri::command]
pub async fn preview_probe(url: String) -> Result<PreviewProbe, String> {
    tauri::async_runtime::spawn_blocking(move || probe(&url))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::thread;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "monocode-preview-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn loopback_url_takes_only_this_machine() {
        for good in [
            "http://localhost:5173/",
            "http://LOCALHOST:3000",
            "http://127.0.0.1:8080/app",
            "http://127.5.6.7:8080",
            "http://[::1]:3000/",
            "https://localhost:8443",
            "http://localhost/",
        ] {
            assert!(loopback_url(good).is_ok(), "{good}");
        }
        for bad in [
            "http://localhost:@other.host/",
            "http://user@localhost:3000/",
            "http://user:pw@localhost:3000/",
            "http://localhost.evil.com:3000/",
            "http://evil.com/?localhost:3000",
            "http://0.0.0.0:3000/",
            "http://10.0.0.2:3000/",
            "http://[::2]:3000/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ws://localhost:3000",
            "not a url",
            "",
        ] {
            assert!(loopback_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn loopback_addrs_never_resolve_a_name() {
        assert_eq!(loopback_addrs("localhost:80").unwrap().len(), 2);
        assert!(loopback_addrs("127.0.0.1:80").is_ok());
        assert!(loopback_addrs("[::1]:80").is_ok());
        assert!(loopback_addrs("example.com:80").is_err());
        assert!(loopback_addrs("10.1.1.1:80").is_err());
        assert!(loopback_addrs("localhost").is_err());
    }

    #[test]
    fn frame_refusal_reads_both_headers() {
        assert!(frame_refusal(Some("DENY"), None).is_some());
        assert!(frame_refusal(Some("sameorigin"), None).is_some());
        assert!(frame_refusal(Some("ALLOWALL"), None).is_none());
        assert!(frame_refusal(None, Some("default-src 'self'; frame-ancestors 'none'")).is_some());
        assert!(frame_refusal(None, Some("frame-ancestors 'self'")).is_some());
        assert!(frame_refusal(None, Some("frame-ancestors *")).is_none());
        assert!(frame_refusal(None, Some("default-src 'self'")).is_none());
        assert!(frame_refusal(None, None).is_none());
    }

    #[test]
    fn config_files_stay_inside_the_project() {
        let root = temp_dir("config");
        fs::create_dir_all(root.join(".claude")).unwrap();
        fs::write(root.join(".claude/launch.json"), "{\"configurations\":[]}").unwrap();
        fs::write(
            root.join("package.json"),
            "{\"scripts\":{\"dev\":\"vite\"}}",
        )
        .unwrap();
        fs::write(root.join("pnpm-lock.yaml"), "").unwrap();
        let files = read_config_files(root.to_str().unwrap()).unwrap();
        assert_eq!(
            files.launch_json.as_deref(),
            Some("{\"configurations\":[]}")
        );
        assert!(files.package_json.unwrap().contains("vite"));
        assert_eq!(files.lockfiles, vec!["pnpm-lock.yaml".to_string()]);
        assert!(files.skipped.is_empty());
        assert!(files.npmrc.is_none());
        fs::write(root.join(".npmrc"), "node-options=--require ./x.js\n").unwrap();
        let files = read_config_files(root.to_str().unwrap()).unwrap();
        assert_eq!(
            files.npmrc.as_deref(),
            Some("node-options=--require ./x.js\n")
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn an_npmrc_link_out_of_the_project_is_skipped_by_name() {
        let root = temp_dir("npmrc-link");
        let outside = temp_dir("npmrc-outside");
        fs::write(outside.join("npmrc"), "script-shell=/tmp/x\n").unwrap();
        std::os::unix::fs::symlink(outside.join("npmrc"), root.join(".npmrc")).unwrap();
        let files = read_config_files(root.to_str().unwrap()).unwrap();
        assert!(files.npmrc.is_none());
        assert!(
            files.skipped.iter().any(|reason| reason.starts_with(".npmrc")),
            "{:?}",
            files.skipped
        );
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_config_link_out_of_the_project_is_refused() {
        let root = temp_dir("link-root");
        let outside = temp_dir("link-outside");
        fs::write(outside.join("package.json"), "{\"secret\":true}").unwrap();
        std::os::unix::fs::symlink(outside.join("package.json"), root.join("package.json"))
            .unwrap();
        std::os::unix::fs::symlink(&outside, root.join(".claude")).unwrap();
        fs::write(outside.join("launch.json"), "{}").unwrap();
        let files = read_config_files(root.to_str().unwrap()).unwrap();
        assert!(files.package_json.is_none());
        assert!(files.launch_json.is_none());
        assert_eq!(files.skipped.len(), 2, "{:?}", files.skipped);
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn missing_files_are_not_errors_and_large_ones_are_skipped() {
        let root = temp_dir("missing");
        let files = read_config_files(root.to_str().unwrap()).unwrap();
        assert_eq!(files, PreviewConfigFiles::default());
        fs::write(
            root.join("package.json"),
            vec![b' '; (MAX_CONFIG_BYTES + 1) as usize],
        )
        .unwrap();
        let files = read_config_files(root.to_str().unwrap()).unwrap();
        assert!(files.package_json.is_none());
        assert_eq!(files.skipped.len(), 1);
        assert!(read_config_files("relative/path").is_err());
        assert!(read_config_files("").is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn resolve_cwd_refuses_escapes_and_takes_names_literally() {
        let root = temp_dir("cwd");
        fs::create_dir_all(root.join("web app")).unwrap();
        fs::create_dir_all(root.join("-dash")).unwrap();
        let r = root.to_str().unwrap().to_string();
        assert_eq!(
            preview_resolve_cwd(r.clone(), "".into()).unwrap(),
            root.to_string_lossy()
        );
        assert!(preview_resolve_cwd(r.clone(), "web app".into())
            .unwrap()
            .ends_with("web app"));
        assert!(preview_resolve_cwd(r.clone(), "-dash".into()).is_ok());
        assert!(preview_resolve_cwd(r.clone(), "./web app/.".into()).is_ok());
        assert!(preview_resolve_cwd(r.clone(), "..".into()).is_err());
        assert!(preview_resolve_cwd(r.clone(), "web app/../..".into()).is_err());
        assert!(preview_resolve_cwd(r.clone(), "/tmp".into()).is_err());
        assert!(preview_resolve_cwd(r.clone(), "nope".into()).is_err());
        #[cfg(unix)]
        {
            let outside = temp_dir("cwd-outside");
            std::os::unix::fs::symlink(&outside, root.join("out")).unwrap();
            assert!(preview_resolve_cwd(r.clone(), "out".into()).is_err());
            fs::remove_dir_all(&outside).unwrap();
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn free_port_is_a_real_port() {
        let port = preview_free_port().unwrap();
        assert!(port > 0);
    }

    /// A one-shot HTTP server on loopback that answers with `response`.
    fn serve_once(response: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(response.as_bytes());
            }
        });
        port
    }

    #[test]
    fn probe_reports_status_and_framing() {
        let ok = serve_once("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi");
        let result = probe(&format!("http://127.0.0.1:{ok}/"));
        assert_eq!(result.status, Some(200));
        assert!(!result.frame_blocked);

        let broken = serve_once(
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        assert_eq!(
            probe(&format!("http://localhost:{broken}/")).status,
            Some(500)
        );

        let denied = serve_once(
            "HTTP/1.1 200 OK\r\nX-Frame-Options: DENY\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let result = probe(&format!("http://127.0.0.1:{denied}/"));
        assert!(result.frame_blocked);
        assert_eq!(
            result.frame_reason.as_deref(),
            Some("X-Frame-Options: DENY")
        );
    }

    #[test]
    fn probe_never_follows_a_redirect() {
        let redirect = serve_once(
            "HTTP/1.1 302 Found\r\nLocation: http://example.com/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let result = probe(&format!("http://127.0.0.1:{redirect}/"));
        assert_eq!(result.status, Some(302));
    }

    #[test]
    fn probe_refuses_other_hosts_without_a_request() {
        let result = probe("http://localhost:@example.com/");
        assert!(result.status.is_none());
        assert!(result.error.is_some());
        let result = probe("http://example.com:80/");
        assert!(result.status.is_none());
    }

    #[test]
    fn probe_reports_a_closed_port_as_an_error() {
        let port = preview_free_port().unwrap();
        let result = probe(&format!("http://127.0.0.1:{port}/"));
        assert!(result.status.is_none());
        assert!(result.error.is_some());
    }
}
