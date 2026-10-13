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
    /// SHA-256, in hex, of the project's `.npmrc`, when present and inside
    /// the project. npm reads it when it runs a script, so it goes into the
    /// preview's fingerprint. Only the hash crosses to the webview: the file
    /// can hold a registry token.
    pub npmrc_sha256: Option<String>,
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
    let npmrc_sha256 = read_config(&root, ".npmrc", &mut skipped).map(|text| {
        use sha2::{Digest, Sha256};
        Sha256::digest(text.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    });
    let lockfiles = LOCKFILES
        .iter()
        .filter(|name| root.join(name).is_file())
        .map(|name| (*name).to_string())
        .collect();
    Ok(PreviewConfigFiles {
        launch_json,
        package_json,
        npmrc_sha256,
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
    match loopback_agent().get(url.as_str()).call() {
        Ok(response) => read_response(response),
        Err(ureq::Error::Status(_, response)) => read_response(response),
        Err(ureq::Error::Transport(error)) => PreviewProbe {
            error: Some(error.to_string()),
            ..PreviewProbe::default()
        },
    }
}

/// Largest script read for the parse check, in bytes.
const SCRIPT_BODY_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewScript {
    pub status: Option<u16>,
    pub content_type: Option<String>,
    /// The body as text, when it is under `SCRIPT_BODY_BYTES` and UTF-8.
    pub body: Option<String>,
    /// Larger than the limit: not read whole, so not checked.
    pub too_large: bool,
    pub error: Option<String>,
}

fn loopback_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .resolver(|netloc: &str| loopback_addrs(netloc))
        .redirects(0)
        .timeout_connect(PROBE_CONNECT)
        .timeout_read(PROBE_READ)
        .user_agent("MonoCode preview check")
        .build()
}

/// One GET for a script the preview serves, for the parse check (Mac test
/// 6.8). The same limits as the probe: loopback only, no redirects, a name
/// never reaches a resolver. The body is read up to 1 MB.
pub fn fetch_script(raw: &str) -> PreviewScript {
    let url = match loopback_url(raw) {
        Ok(url) => url,
        Err(error) => {
            return PreviewScript {
                error: Some(error),
                ..PreviewScript::default()
            }
        }
    };
    let response = match loopback_agent().get(url.as_str()).call() {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(ureq::Error::Transport(error)) => {
            return PreviewScript {
                error: Some(error.to_string()),
                ..PreviewScript::default()
            }
        }
    };
    let status = response.status();
    let content_type = response.header("content-type").map(str::to_string);
    let mut bytes = Vec::new();
    let read = response
        .into_reader()
        .take(SCRIPT_BODY_BYTES + 1)
        .read_to_end(&mut bytes);
    if let Err(error) = read {
        return PreviewScript {
            status: Some(status),
            content_type,
            error: Some(error.to_string()),
            ..PreviewScript::default()
        };
    }
    if bytes.len() as u64 > SCRIPT_BODY_BYTES {
        return PreviewScript {
            status: Some(status),
            content_type,
            too_large: true,
            ..PreviewScript::default()
        };
    }
    PreviewScript {
        status: Some(status),
        content_type,
        body: String::from_utf8(bytes).ok(),
        too_large: false,
        error: None,
    }
}

/// Where a listener on the preview's port is bound.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ListenAddr {
    /// Every address (`*`, `0.0.0.0`, `::`).
    Any,
    /// One loopback address.
    Ip(IpAddr),
}

/// One process listening on the port, and where.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PortListener {
    pid: u32,
    addr: ListenAddr,
}

/// The loopback addresses a URL's host stands for, in the order tried.
fn url_addrs(url: &Url) -> Vec<IpAddr> {
    match url.host() {
        Some(Host::Domain(_)) => vec![
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
        ],
        Some(Host::Ipv4(ip)) => vec![IpAddr::V4(ip)],
        Some(Host::Ipv6(ip)) => vec![IpAddr::V6(ip)],
        None => Vec::new(),
    }
}

/// The one address to connect to for a preview's port, or None to refuse
/// (security fix R5). Every listener seen on the port must belong to the
/// preview. Then the address must be one the preview itself is bound to.
/// `complete` says whether the listing shows every user's listeners: Linux's
/// `/proc/net` does, so a preview bound to every address also holds
/// 127.0.0.1 there. `lsof` without root does not list another user's
/// sockets, so on macOS a stranger's `127.0.0.1:P` beside the preview's
/// `*:P` would not show: only an exact address counts.
fn preview_connect_addr(
    listeners: &[PortListener],
    owned: &dyn Fn(u32) -> bool,
    complete: bool,
    wanted: &[IpAddr],
) -> Option<IpAddr> {
    if listeners.is_empty() || !listeners.iter().all(|l| owned(l.pid)) {
        return None;
    }
    wanted.iter().copied().find(|ip| {
        listeners
            .iter()
            .any(|l| l.addr == ListenAddr::Ip(*ip) || (complete && l.addr == ListenAddr::Any))
    })
}

/// Whether this platform's listing shows every user's listeners.
const LISTENERS_COMPLETE: bool = cfg!(target_os = "linux");

/// The address on this loopback port to read from, when every listener on
/// it belongs to the process session MonoCode started for a preview. The
/// preview runs under `setsid`, so its server (`npm` -> `node` -> `vite`)
/// shares the leader's session id. A port nobody listens on, one another
/// program also listens on, one whose owner this user cannot see, or (on
/// macOS) one the preview holds only through a wildcard, is refused.
#[cfg(unix)]
fn port_held_by_session(leader: u32, port: u16, wanted: &[IpAddr]) -> Option<IpAddr> {
    let listeners = loopback_listeners(port)?;
    let owned = |pid: u32| {
        // SAFETY: getsid only reads the session id of a process.
        pid == leader || unsafe { libc::getsid(pid as libc::pid_t) } == leader as libc::pid_t
    };
    preview_connect_addr(&listeners, &owned, LISTENERS_COMPLETE, wanted)
}

#[cfg(not(unix))]
fn port_held_by_session(_leader: u32, _port: u16, _wanted: &[IpAddr]) -> Option<IpAddr> {
    None
}

/// True for a listening address a loopback connection reaches: loopback or
/// any address, IPv4 or IPv6, in `/proc/net/tcp` hex form.
#[cfg(target_os = "linux")]
fn proc_loopback_or_any(hex: &str) -> bool {
    match hex.len() {
        // IPv4, little-endian: 127.x.x.x ends in 7F.
        8 => hex == "00000000" || hex.ends_with("7F"),
        32 => {
            hex == "00000000000000000000000000000000"
                || hex == "00000000000000000000000001000000"
                || (hex.starts_with("0000000000000000FFFF0000") && hex.ends_with("7F"))
                || hex == "0000000000000000FFFF000000000000"
        }
        _ => false,
    }
}

/// A `/proc/net/tcp` address read as where it listens. IPv4 is one
/// little-endian word; IPv6 is four. A v4-mapped address counts as IPv4.
#[cfg(target_os = "linux")]
fn proc_listen_addr(hex: &str) -> Option<ListenAddr> {
    let word = |chunk: &str| u32::from_str_radix(chunk, 16).ok().map(u32::swap_bytes);
    let addr = match hex.len() {
        8 => IpAddr::V4(Ipv4Addr::from(word(hex)?)),
        32 => {
            let mut octets = [0u8; 16];
            for i in 0..4 {
                let value = word(hex.get(i * 8..i * 8 + 8)?)?;
                octets[i * 4..i * 4 + 4].copy_from_slice(&value.to_be_bytes());
            }
            let v6 = Ipv6Addr::from(octets);
            match v6.to_ipv4_mapped() {
                Some(v4) => IpAddr::V4(v4),
                None => IpAddr::V6(v6),
            }
        }
        _ => return None,
    };
    Some(if addr.is_unspecified() {
        ListenAddr::Any
    } else {
        ListenAddr::Ip(addr)
    })
}

/// The processes listening on this port on a loopback or wildcard address,
/// with where each listens, or None when a listener's owner cannot be found.
#[cfg(target_os = "linux")]
fn loopback_listeners(port: u16) -> Option<Vec<PortListener>> {
    use std::collections::{HashMap, HashSet};
    let mut inodes: HashMap<u64, ListenAddr> = HashMap::new();
    for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(text) = fs::read_to_string(table) else {
            continue;
        };
        for line in text.lines().skip(1) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            // local_address, state 0A is LISTEN, inode is the tenth field.
            if fields.len() < 10 || fields[3] != "0A" {
                continue;
            }
            let Some((addr, hex_port)) = fields[1].rsplit_once(':') else {
                continue;
            };
            if u16::from_str_radix(hex_port, 16).ok() != Some(port) || !proc_loopback_or_any(addr) {
                continue;
            }
            let (Ok(inode), Some(listen)) = (fields[9].parse::<u64>(), proc_listen_addr(addr))
            else {
                // A listener that cannot be read refuses the port.
                return None;
            };
            inodes.insert(inode, listen);
        }
    }
    if inodes.is_empty() {
        return Some(Vec::new());
    }
    if inodes.contains_key(&0) {
        return None;
    }
    let mut found: HashSet<u64> = HashSet::new();
    let mut listeners = Vec::new();
    for entry in fs::read_dir("/proc").ok()?.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(fds) = fs::read_dir(entry.path().join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            let Ok(target) = fs::read_link(fd.path()) else {
                continue;
            };
            let target = target.to_string_lossy();
            let Some(inode) = target
                .strip_prefix("socket:[")
                .and_then(|rest| rest.strip_suffix(']'))
                .and_then(|n| n.parse::<u64>().ok())
            else {
                continue;
            };
            if let Some(&addr) = inodes.get(&inode) {
                found.insert(inode);
                let listener = PortListener { pid, addr };
                if !listeners.contains(&listener) {
                    listeners.push(listener);
                }
            }
        }
    }
    // A socket whose owner is hidden (another user's process) is refused.
    (found.len() == inodes.len()).then_some(listeners)
}

/// `lsof -F pn` output read as listeners on loopback or every address.
/// Addresses another machine would use are left out: the fetch never
/// connects to them.
#[cfg(any(target_os = "macos", test))]
fn parse_lsof_listeners(text: &str) -> Vec<PortListener> {
    let mut listeners = Vec::new();
    let mut current: Option<u32> = None;
    for line in text.lines() {
        if let Some(pid) = line.strip_prefix('p') {
            current = pid.parse().ok();
        } else if let Some(name) = line.strip_prefix('n') {
            let host = name.rsplit_once(':').map(|(h, _)| h).unwrap_or(name);
            let addr = if host == "*" || host == "[::]" {
                Some(ListenAddr::Any)
            } else {
                host.trim_start_matches('[')
                    .trim_end_matches(']')
                    .parse::<IpAddr>()
                    .ok()
                    .map(|ip| match ip {
                        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
                        ip => ip,
                    })
                    .filter(|ip| ip.is_loopback() || ip.is_unspecified())
                    .map(|ip| {
                        if ip.is_unspecified() {
                            ListenAddr::Any
                        } else {
                            ListenAddr::Ip(ip)
                        }
                    })
            };
            if let (Some(addr), Some(pid)) = (addr, current) {
                let listener = PortListener { pid, addr };
                if !listeners.contains(&listener) {
                    listeners.push(listener);
                }
            }
        }
    }
    listeners
}

/// The processes listening on this port on a loopback or wildcard address,
/// from `lsof` (an absolute path and an argument list, no shell). None when
/// it cannot be run.
#[cfg(target_os = "macos")]
fn loopback_listeners(port: u16) -> Option<Vec<PortListener>> {
    let output = std::process::Command::new("/usr/sbin/lsof")
        .args(["-nP", "-w", "-Fpn", "-sTCP:LISTEN"])
        .arg(format!("-iTCP:{port}"))
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    Some(parse_lsof_listeners(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn loopback_listeners(_port: u16) -> Option<Vec<PortListener>> {
    None
}

/// `fetch_script` for a running preview only (security fix F6): the URL's
/// port must be one the preview's own processes listen on. `leader` is the
/// preview's process id, found from the preview id in Rust, never taken
/// from the caller.
pub fn fetch_preview_script(leader: Option<u32>, raw: &str) -> PreviewScript {
    let refuse = |error: &str| PreviewScript {
        error: Some(error.into()),
        ..PreviewScript::default()
    };
    let Some(leader) = leader else {
        return refuse("This preview is not running");
    };
    let url = match loopback_url(raw) {
        Ok(url) => url,
        Err(error) => return refuse(&error),
    };
    let Some(port) = url.port_or_known_default() else {
        return refuse("A preview URL needs a port");
    };
    let Some(ip) = port_held_by_session(leader, port, &url_addrs(&url)) else {
        return refuse("Only the running preview's own port can be read");
    };
    // Connect to the address the preview itself listens on, nothing else
    // `localhost` could reach.
    let mut url = url;
    if url.set_ip_host(ip).is_err() {
        return refuse("Only the running preview's own port can be read");
    }
    fetch_script(url.as_str())
}

#[tauri::command]
pub async fn preview_fetch_script(
    host: tauri::State<'_, crate::pty::PtyHost>,
    preview_id: String,
    url: String,
) -> Result<PreviewScript, String> {
    let leader = host.owned_pid(&preview_id);
    tauri::async_runtime::spawn_blocking(move || fetch_preview_script(leader, &url))
        .await
        .map_err(|e| e.to_string())
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
        assert!(files.npmrc_sha256.is_none());
        fs::write(root.join(".npmrc"), "//r.example/:_authToken=npm_secret\n").unwrap();
        let files = read_config_files(root.to_str().unwrap()).unwrap();
        let hash = files.npmrc_sha256.clone().unwrap();
        assert_eq!(hash.len(), 64);
        assert!(hash.bytes().all(|b| b.is_ascii_hexdigit()));
        // The token never leaves Rust: only the hash is serialised.
        let json = serde_json::to_string(&files).unwrap();
        assert!(!json.contains("npm_secret"), "{json}");
        assert!(json.contains("\"npmrcSha256\""), "{json}");
        fs::write(root.join(".npmrc"), "//r.example/:_authToken=other\n").unwrap();
        let changed = read_config_files(root.to_str().unwrap()).unwrap();
        assert_ne!(changed.npmrc_sha256.unwrap(), hash);
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
        assert!(files.npmrc_sha256.is_none());
        assert!(
            files
                .skipped
                .iter()
                .any(|reason| reason.starts_with(".npmrc")),
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

    // Mac test 6.8: the parse check reads a script the preview serves.
    #[test]
    fn fetch_script_reads_the_body_on_loopback_only() {
        let ok = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\nContent-Length: 9\r\nConnection: close\r\n\r\nconst = ;",
        );
        let script = fetch_script(&format!("http://127.0.0.1:{ok}/src/main.js"));
        assert_eq!(script.status, Some(200));
        assert_eq!(script.body.as_deref(), Some("const = ;"));
        assert_eq!(script.content_type.as_deref(), Some("text/javascript"));
        assert!(!script.too_large);

        let elsewhere = fetch_script("http://example.com:80/main.js");
        assert!(elsewhere.status.is_none());
        assert!(elsewhere.body.is_none());
        assert!(elsewhere.error.is_some());

        let redirect = serve_once(
            "HTTP/1.1 302 Found\r\nLocation: http://example.com/x.js\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let script = fetch_script(&format!("http://127.0.0.1:{redirect}/x.js"));
        assert_eq!(script.status, Some(302));
    }

    // Security fix F6: the script fetch reads only a port the running
    // preview's own processes listen on.
    #[cfg(target_os = "linux")]
    #[test]
    fn fetch_preview_script_reads_only_the_previews_own_port() {
        // The listener in `serve_once` runs in this test process, so its
        // session is this process's session.
        // SAFETY: getsid(0) reads this process's session id.
        let session = unsafe { libc::getsid(0) } as u32;
        let ok = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\nContent-Length: 2\r\nConnection: close\r\n\r\n1;",
        );
        let script = fetch_preview_script(Some(session), &format!("http://127.0.0.1:{ok}/a.js"));
        assert_eq!(script.status, Some(200), "{:?}", script.error);
        assert_eq!(script.body.as_deref(), Some("1;"));

        // No preview running.
        let other = serve_once("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        let none = fetch_preview_script(None, &format!("http://127.0.0.1:{other}/a.js"));
        assert!(none.status.is_none());
        assert_eq!(none.error.as_deref(), Some("This preview is not running"));

        // A port held by another session (here: a leader that is not ours).
        let foreign = fetch_preview_script(Some(1), &format!("http://127.0.0.1:{other}/a.js"));
        assert!(foreign.status.is_none());
        assert_eq!(
            foreign.error.as_deref(),
            Some("Only the running preview's own port can be read")
        );

        // A port nobody listens on.
        let closed = preview_free_port().unwrap();
        let closed =
            fetch_preview_script(Some(session), &format!("http://127.0.0.1:{closed}/a.js"));
        assert!(closed.status.is_none());
        assert!(closed.error.is_some());

        // Still loopback only.
        let elsewhere = fetch_preview_script(Some(session), "http://example.com:80/a.js");
        assert!(elsewhere.status.is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn proc_addresses_reach_loopback_or_any() {
        assert!(proc_loopback_or_any("0100007F"));
        assert!(proc_loopback_or_any("00000000"));
        assert!(!proc_loopback_or_any("0101A8C0"));
        assert!(proc_loopback_or_any("00000000000000000000000001000000"));
        assert!(proc_loopback_or_any("00000000000000000000000000000000"));
        assert!(proc_loopback_or_any("0000000000000000FFFF00000100007F"));
        assert!(!proc_loopback_or_any("000080FE00000000FF005450B6AD1DFE"));
    }

    // Security fix R5: lsof without root lists only this user's sockets.
    #[test]
    fn lsof_output_reads_as_listeners() {
        let text = "p501\nf20\nn*:5173\np502\nn127.0.0.1:5173\nn[::1]:5173\nn[::]:5173\nn192.168.1.5:5173\np503\nn[::ffff:127.0.0.1]:5173\n";
        let v4 = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let v6 = IpAddr::V6(Ipv6Addr::LOCALHOST);
        assert_eq!(
            parse_lsof_listeners(text),
            vec![
                PortListener {
                    pid: 501,
                    addr: ListenAddr::Any
                },
                PortListener {
                    pid: 502,
                    addr: ListenAddr::Ip(v4)
                },
                PortListener {
                    pid: 502,
                    addr: ListenAddr::Ip(v6)
                },
                PortListener {
                    pid: 502,
                    addr: ListenAddr::Any
                },
                PortListener {
                    pid: 503,
                    addr: ListenAddr::Ip(v4)
                },
            ]
        );
        assert!(parse_lsof_listeners("").is_empty());
    }

    #[test]
    fn a_wildcard_preview_counts_for_loopback_only_where_the_listing_is_complete() {
        let v4 = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let v6 = IpAddr::V6(Ipv6Addr::LOCALHOST);
        let ours = |pid: u32| pid == 10 || pid == 11;
        let any = [PortListener {
            pid: 10,
            addr: ListenAddr::Any,
        }];
        // macOS: another user's 127.0.0.1:P beside the preview's *:P would
        // not be listed, so a wildcard is not enough.
        assert_eq!(preview_connect_addr(&any, &ours, false, &[v4, v6]), None);
        // Linux lists every user's sockets: the wildcard holds 127.0.0.1.
        assert_eq!(preview_connect_addr(&any, &ours, true, &[v4, v6]), Some(v4));
        // Bound to exactly the address: fine on both.
        let exact = [PortListener {
            pid: 11,
            addr: ListenAddr::Ip(v6),
        }];
        for complete in [false, true] {
            assert_eq!(
                preview_connect_addr(&exact, &ours, complete, &[v4, v6]),
                Some(v6)
            );
            assert_eq!(preview_connect_addr(&exact, &ours, complete, &[v4]), None);
        }
        // `localhost` connects to the exact address the preview holds.
        let both = [
            PortListener {
                pid: 10,
                addr: ListenAddr::Any,
            },
            PortListener {
                pid: 11,
                addr: ListenAddr::Ip(v4),
            },
        ];
        assert_eq!(
            preview_connect_addr(&both, &ours, false, &[v4, v6]),
            Some(v4)
        );
        // Any listener that is not the preview's refuses the port.
        let shared = [
            PortListener {
                pid: 11,
                addr: ListenAddr::Ip(v4),
            },
            PortListener {
                pid: 99,
                addr: ListenAddr::Ip(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2))),
            },
        ];
        for complete in [false, true] {
            assert_eq!(preview_connect_addr(&shared, &ours, complete, &[v4]), None);
            assert_eq!(preview_connect_addr(&[], &ours, complete, &[v4]), None);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn proc_addresses_read_as_where_they_listen() {
        let v4 = IpAddr::V4(Ipv4Addr::LOCALHOST);
        assert_eq!(proc_listen_addr("0100007F"), Some(ListenAddr::Ip(v4)));
        assert_eq!(proc_listen_addr("00000000"), Some(ListenAddr::Any));
        assert_eq!(
            proc_listen_addr("00000000000000000000000001000000"),
            Some(ListenAddr::Ip(IpAddr::V6(Ipv6Addr::LOCALHOST)))
        );
        assert_eq!(
            proc_listen_addr("00000000000000000000000000000000"),
            Some(ListenAddr::Any)
        );
        assert_eq!(
            proc_listen_addr("0000000000000000FFFF00000100007F"),
            Some(ListenAddr::Ip(v4))
        );
        assert_eq!(
            proc_listen_addr("0000000000000000FFFF000000000000"),
            Some(ListenAddr::Any)
        );
        assert_eq!(proc_listen_addr("zz"), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fetch_preview_script_connects_to_the_address_the_preview_holds() {
        // SAFETY: getsid(0) reads this process's session id.
        let session = unsafe { libc::getsid(0) } as u32;
        let ok = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\nContent-Length: 2\r\nConnection: close\r\n\r\n1;",
        );
        // `serve_once` binds 127.0.0.1; `localhost` reads from there.
        let script = fetch_preview_script(Some(session), &format!("http://localhost:{ok}/a.js"));
        assert_eq!(script.status, Some(200), "{:?}", script.error);
    }
}
