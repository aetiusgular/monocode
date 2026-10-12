//! Edit adapter for small local models (session 10 of the parallel build).
//!
//! A loopback proxy between Codex and a local model server. It offers the
//! model `edit_file` and `write_file`, and turns each call into the
//! `exec_command` call with an `apply_patch` heredoc that Codex already
//! intercepts. Codex then runs its own verified patch path: its approval card,
//! sandbox, writable folders and tracked diff all stay Codex's. No Codex fork.
//!
//! - Listens on 127.0.0.1 only, on a free port, started on first use.
//! - Each Codex session gets a route, `http://127.0.0.1:<port>/s/<token>`,
//!   with a random token. Codex is pointed at it through the thread's
//!   `model_providers.<id>.base_url` config, so no file holds the port.
//! - A route forwards only to the session's model server, which must be on
//!   loopback, and never follows a redirect.
//! - Requests whose `Host` is not this listener are refused, so a web page
//!   cannot reach it through DNS rebinding.

// Explicit paths, so the contract-check example can compile this file directly.
#[path = "edit_adapter/patch.rs"]
mod patch;
#[path = "edit_adapter/rewrite.rs"]
mod rewrite;

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use patch::{command_for, EditCall};
use rewrite::{rewrite_request, CallMap, StreamRewriter};

const MAX_HEAD_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
const MAX_CONNECTIONS: usize = 32;
const MAX_ROUTES: usize = 256;
/// No byte from the model server for this long ends the request. Codex's own
/// stream idle timeout is 300 seconds unless raised for a slow server.
const UPSTREAM_IDLE_SECS: u64 = 900;

struct Route {
    /// The model server's base, for example `http://127.0.0.1:11434/v1`.
    upstream: url::Url,
    /// The session's working folder. Paths in file calls are relative to it.
    root: PathBuf,
    calls: Mutex<CallMap>,
}

struct Proxy {
    port: u16,
    routes: Mutex<HashMap<String, Arc<Route>>>,
    /// Session id to token, so a session keeps its route, and its call map,
    /// across Codex restarts. Oldest first, for eviction.
    sessions: Mutex<VecDeque<(String, String)>>,
    open: AtomicUsize,
}

static PROXY: OnceLock<Result<Arc<Proxy>, String>> = OnceLock::new();

fn proxy() -> Result<Arc<Proxy>, String> {
    PROXY
        .get_or_init(|| {
            let listener = TcpListener::bind(("127.0.0.1", 0))
                .map_err(|e| format!("edit adapter could not listen: {e}"))?;
            let port = listener
                .local_addr()
                .map_err(|e| format!("edit adapter has no port: {e}"))?
                .port();
            let proxy = Arc::new(Proxy {
                port,
                routes: Mutex::new(HashMap::new()),
                sessions: Mutex::new(VecDeque::new()),
                open: AtomicUsize::new(0),
            });
            let serving = proxy.clone();
            std::thread::Builder::new()
                .name("edit-adapter".into())
                .spawn(move || serve(listener, serving))
                .map_err(|e| format!("edit adapter could not start: {e}"))?;
            Ok(proxy)
        })
        .clone()
}

/// A model server base URL the adapter may forward to: http or https, a
/// loopback host, no user name or password. Parsed, never prefix-matched.
pub fn loopback_upstream(value: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(value.trim())
        .map_err(|_| "The model server URL does not parse.".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("The model server URL must be http or https.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("The model server URL must not hold a user name or password.".into());
    }
    let loopback = match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    if !loopback {
        return Err("The edit adapter forwards only to a model server on this machine.".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("The model server URL must not have a query or fragment.".into());
    }
    Ok(url)
}

/// Opens, or reuses, the route for one Codex session. Returns the base URL
/// Codex should use in place of the provider's own.
pub fn open_route(session_id: &str, upstream: &str, cwd: &str) -> Result<String, String> {
    if session_id.is_empty() || session_id.len() > 200 {
        return Err("The session id is not valid.".into());
    }
    let upstream = loopback_upstream(upstream)?;
    let root = PathBuf::from(cwd);
    if !root.is_absolute() || !root.is_dir() {
        return Err("The session folder must be an absolute path to a folder.".into());
    }
    let root = root
        .canonicalize()
        .map_err(|_| "The session folder cannot be read.".to_string())?;
    let proxy = proxy()?;
    let mut sessions = proxy.sessions.lock().map_err(|_| "edit adapter lock")?;
    let mut routes = proxy.routes.lock().map_err(|_| "edit adapter lock")?;
    if let Some(at) = sessions.iter().position(|(id, _)| id == session_id) {
        let token = sessions[at].1.clone();
        if let Some(route) = routes.get(&token) {
            if route.upstream == upstream && route.root == root {
                return Ok(base_url(proxy.port, &token));
            }
        }
        // The server or the folder changed: a new route, a new call map.
        sessions.remove(at);
        routes.remove(&token);
    }
    // Routes are not closed when a chat ends, so the oldest give way. A chat
    // whose route went gets a new one the next time its Codex starts.
    while sessions.len() >= MAX_ROUTES {
        if let Some((_, old)) = sessions.pop_front() {
            routes.remove(&old);
        }
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    routes.insert(
        token.clone(),
        Arc::new(Route {
            upstream,
            root,
            calls: Mutex::new(CallMap::default()),
        }),
    );
    sessions.push_back((session_id.to_string(), token.clone()));
    Ok(base_url(proxy.port, &token))
}

/// Closes a session's route. Nothing else is touched.
pub fn close_route(session_id: &str) {
    let Some(Ok(proxy)) = PROXY.get() else { return };
    let token = proxy.sessions.lock().ok().and_then(|mut s| {
        let at = s.iter().position(|(id, _)| id == session_id)?;
        s.remove(at).map(|(_, token)| token)
    });
    if let (Some(token), Ok(mut routes)) = (token, proxy.routes.lock()) {
        routes.remove(&token);
    }
}

fn base_url(port: u16, token: &str) -> String {
    format!("http://127.0.0.1:{port}/s/{token}")
}

fn serve(listener: TcpListener, proxy: Arc<Proxy>) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        if proxy.open.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            proxy.open.fetch_sub(1, Ordering::SeqCst);
            let mut stream = stream;
            let _ = respond(&mut stream, 503, "too many connections");
            continue;
        }
        let proxy = proxy.clone();
        let spawned = std::thread::Builder::new()
            .name("edit-adapter-conn".into())
            .spawn({
                let proxy = proxy.clone();
                move || {
                    let mut stream = stream;
                    if let Err(message) = handle(&mut stream, &proxy) {
                        let _ = respond(&mut stream, message.0, &message.1);
                    }
                    proxy.open.fetch_sub(1, Ordering::SeqCst);
                }
            });
        if spawned.is_err() {
            proxy.open.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

fn respond(stream: &mut TcpStream, status: u16, message: &str) -> std::io::Result<()> {
    let body =
        serde_json::json!({ "error": { "message": message, "type": "edit_adapter" } }).to_string();
    write!(
        stream,
        "HTTP/1.1 {status} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        reason(status),
        body.len()
    )?;
    stream.flush()
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

struct Request {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

type Failure = (u16, String);

fn read_request(stream: &TcpStream) -> Result<Request, Failure> {
    let bad = |m: &str| (400, m.to_string());
    stream
        .set_read_timeout(Some(Duration::from_secs(60)))
        .map_err(|_| bad("socket"))?;
    let mut reader = BufReader::new(stream);
    let mut head = Vec::new();
    loop {
        let mut line = Vec::new();
        let n = reader
            .read_until(b'\n', &mut line)
            .map_err(|_| bad("read"))?;
        if n == 0 {
            return Err(bad("closed"));
        }
        head.extend_from_slice(&line);
        if head.len() > MAX_HEAD_BYTES {
            return Err((413, "request head too large".into()));
        }
        if line == b"\r\n" || line == b"\n" {
            break;
        }
    }
    let head = String::from_utf8(head).map_err(|_| bad("head is not UTF-8"))?;
    let mut lines = head.lines();
    let mut first = lines.next().unwrap_or("").split(' ');
    let method = first.next().unwrap_or("").to_string();
    let target = first.next().unwrap_or("").to_string();
    let mut headers = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let mut request = Request {
        method,
        target,
        headers,
        body: Vec::new(),
    };
    let chunked = request
        .header("transfer-encoding")
        .is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    if chunked {
        loop {
            let mut size_line = String::new();
            reader.read_line(&mut size_line).map_err(|_| bad("chunk"))?;
            let size = usize::from_str_radix(size_line.trim().split(';').next().unwrap_or(""), 16)
                .map_err(|_| bad("chunk size"))?;
            if request.body.len() + size > MAX_BODY_BYTES {
                return Err((413, "request body too large".into()));
            }
            let mut chunk = vec![0; size + 2];
            reader.read_exact(&mut chunk).map_err(|_| bad("chunk"))?;
            if size == 0 {
                break;
            }
            request.body.extend_from_slice(&chunk[..size]);
        }
    } else if let Some(length) = request.header("content-length") {
        let length: usize = length.parse().map_err(|_| bad("content-length"))?;
        if length > MAX_BODY_BYTES {
            return Err((413, "request body too large".into()));
        }
        request.body = vec![0; length];
        reader
            .read_exact(&mut request.body)
            .map_err(|_| bad("body"))?;
    }
    Ok(request)
}

fn handle(stream: &mut TcpStream, proxy: &Proxy) -> Result<(), Failure> {
    let request = read_request(stream)?;
    let host_ok = request.header("host").is_some_and(|host| {
        host == format!("127.0.0.1:{}", proxy.port) || host == format!("localhost:{}", proxy.port)
    });
    if !host_ok {
        return Err((403, "unexpected host".into()));
    }
    let rest = request
        .target
        .strip_prefix("/s/")
        .ok_or((404, "no route".to_string()))?;
    let (token, tail) = rest.split_at(rest.find(['/', '?']).unwrap_or(rest.len()));
    let route = proxy
        .routes
        .lock()
        .map_err(|_| (503, "lock".to_string()))?
        .get(token)
        .cloned()
        .ok_or((404, "no route".to_string()))?;
    let upstream_url = join_upstream(&route.upstream, tail).ok_or((400, "bad path".to_string()))?;

    let is_responses = request.method == "POST" && upstream_url.path().ends_with("/responses");
    let encoded = request
        .header("content-encoding")
        .is_some_and(|v| !v.eq_ignore_ascii_case("identity"));
    let body = if is_responses && !encoded {
        let calls = route.calls.lock().map_err(|_| (503, "lock".to_string()))?;
        rewrite_request(&request.body, &calls)
    } else {
        None
    };
    let rewriting = body.is_some();
    let body = body.unwrap_or(request.body.clone());

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        // Between bytes, not for the whole reply: a slow model streams on,
        // and a stalled server frees this thread instead of holding it.
        .timeout_read(Duration::from_secs(UPSTREAM_IDLE_SECS))
        .redirects(0)
        .build();
    let mut upstream = agent.request(&request.method, upstream_url.as_str());
    for (name, value) in &request.headers {
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "host"
                | "connection"
                | "content-length"
                | "transfer-encoding"
                | "accept-encoding"
                | "keep-alive"
                | "upgrade"
                | "proxy-authorization"
                | "te"
                | "trailer"
        ) {
            continue;
        }
        upstream = upstream.set(name, value);
    }
    let response = match upstream.send_bytes(&body) {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(error) => return Err((502, format!("model server: {error}"))),
    };
    let status = response.status();
    let event_stream = response
        .header("content-type")
        .is_some_and(|v| v.starts_with("text/event-stream"));
    let mut head = format!("HTTP/1.1 {status} {}\r\n", response.status_text());
    for name in response.headers_names() {
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "content-length"
                | "transfer-encoding"
                | "connection"
                | "content-encoding"
                | "keep-alive"
        ) {
            continue;
        }
        for value in response.all(&name) {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    head.push_str("connection: close\r\n\r\n");
    let write_err = |_| (502, "client closed".to_string());
    stream.write_all(head.as_bytes()).map_err(write_err)?;
    let mut reader = response.into_reader();
    let mut buffer = [0u8; 16 * 1024];
    if rewriting && event_stream && status < 400 {
        let root = route.root.clone();
        let mut rewriter = StreamRewriter::new(move |call: Result<&EditCall, &str>| match call {
            Ok(call) => command_for(&root, call),
            Err(message) => patch::refusal_command(message),
        });
        // Calls are recorded before the bytes that name them go out, so the
        // next request's history rewrite always finds them.
        let remember = |rewriter: &mut StreamRewriter| {
            let new = rewriter.take_calls();
            if !new.is_empty() {
                if let Ok(mut calls) = route.calls.lock() {
                    for (id, call) in new {
                        calls.insert(id, call);
                    }
                }
            }
        };
        loop {
            let n = reader
                .read(&mut buffer)
                .map_err(|_| (502, "model stream".to_string()))?;
            if n == 0 {
                break;
            }
            let out = rewriter.push(&buffer[..n]);
            remember(&mut rewriter);
            if !out.is_empty() {
                stream.write_all(&out).map_err(write_err)?;
                stream.flush().map_err(write_err)?;
            }
        }
        stream.write_all(&rewriter.finish()).map_err(write_err)?;
    } else {
        loop {
            let n = reader
                .read(&mut buffer)
                .map_err(|_| (502, "model stream".to_string()))?;
            if n == 0 {
                break;
            }
            stream.write_all(&buffer[..n]).map_err(write_err)?;
            stream.flush().map_err(write_err)?;
        }
    }
    let _ = stream.flush();
    Ok(())
}

/// The model server URL for a path under a route: the route's base path,
/// then the rest of the request path and its query. Refuses `..` segments.
fn join_upstream(base: &url::Url, tail: &str) -> Option<url::Url> {
    let (path, query) = match tail.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (tail, None),
    };
    if path
        .split('/')
        .any(|segment| segment == ".." || segment == ".")
        || path.contains('%')
        || path.contains('\\')
    {
        return None;
    }
    let mut url = base.clone();
    let joined = format!("{}{}", base.path().trim_end_matches('/'), path);
    url.set_path(if joined.is_empty() { "/" } else { &joined });
    url.set_query(query);
    Some(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn upstream_must_be_loopback_and_plain() {
        for good in [
            "http://127.0.0.1:11434/v1",
            "http://localhost:1234/v1",
            "http://[::1]:8080/v1",
            "http://127.9.9.9/v1",
        ] {
            assert!(loopback_upstream(good).is_ok(), "{good}");
        }
        for bad in [
            "http://localhost:@other.host/v1",
            "http://localhost.other.host/v1",
            "http://user:pw@127.0.0.1/v1",
            "https://openrouter.ai/api/v1",
            "http://10.0.0.5:11434/v1",
            "file:///etc/passwd",
            "http://127.0.0.1/v1?x=1",
            "not a url",
        ] {
            assert!(loopback_upstream(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn join_keeps_the_base_path_and_refuses_escapes() {
        let base = url::Url::parse("http://127.0.0.1:11434/v1").unwrap();
        assert_eq!(
            join_upstream(&base, "/responses").unwrap().as_str(),
            "http://127.0.0.1:11434/v1/responses"
        );
        assert_eq!(
            join_upstream(&base, "/models?client_version=1")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:11434/v1/models?client_version=1"
        );
        assert!(join_upstream(&base, "/../api/pull").is_none());
        assert!(join_upstream(&base, "/%2e%2e/api").is_none());
    }

    #[test]
    fn a_route_is_kept_per_session_and_replaced_when_its_server_changes() {
        let dir = std::env::temp_dir();
        let a = open_route(
            "s-route-1",
            "http://127.0.0.1:11434/v1",
            dir.to_str().unwrap(),
        )
        .unwrap();
        let b = open_route(
            "s-route-1",
            "http://127.0.0.1:11434/v1",
            dir.to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(a, b);
        let c = open_route(
            "s-route-1",
            "http://127.0.0.1:1234/v1",
            dir.to_str().unwrap(),
        )
        .unwrap();
        assert_ne!(a, c);
        assert!(open_route("s-route-2", "http://example.com/v1", dir.to_str().unwrap()).is_err());
        assert!(open_route("s-route-2", "http://127.0.0.1:1/v1", "relative").is_err());
        close_route("s-route-1");
    }

    #[test]
    fn the_oldest_route_gives_way_when_the_table_is_full() {
        let dir = std::env::temp_dir();
        let dir = dir.to_str().unwrap();
        let first = open_route("s-evict-first", "http://127.0.0.1:2/v1", dir).unwrap();
        for i in 0..MAX_ROUTES {
            open_route(&format!("s-evict-{i}"), "http://127.0.0.1:2/v1", dir).unwrap();
        }
        let again = open_route("s-evict-first", "http://127.0.0.1:2/v1", dir).unwrap();
        assert_ne!(first, again);
        for i in 0..MAX_ROUTES {
            close_route(&format!("s-evict-{i}"));
        }
        close_route("s-evict-first");
    }

    /// A model server that answers one request with a canned stream and
    /// hands back what it received.
    fn fake_upstream(reply: &'static str) -> (u16, std::sync::mpsc::Receiver<String>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&stream).unwrap();
            tx.send(format!(
                "{} {}\n{}",
                request.method,
                request.target,
                String::from_utf8_lossy(&request.body)
            ))
            .unwrap();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n{reply}"
            )
            .unwrap();
        });
        (port, rx)
    }

    #[test]
    fn proxy_rewrites_a_live_exchange_end_to_end() {
        let root = std::env::temp_dir().join(format!(
            "edit-adapter-e2e-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("hello.py"), "def greet():\n    return \"hi\"\n").unwrap();
        let args = serde_json::json!({ "path": "hello.py", "old_text": "\"hi\"", "new_text": "\"hello\"" }).to_string();
        let item = serde_json::json!({ "type": "function_call", "call_id": "c1", "name": "edit_file", "arguments": args });
        let reply: &'static str = Box::leak(
            format!(
                "data: {}\n\ndata: {}\n\n",
                serde_json::json!({ "type": "response.output_item.done", "output_index": 0, "item": item }),
                serde_json::json!({ "type": "response.completed", "response": { "output": [item] } })
            )
            .into_boxed_str(),
        );
        let (port, received) = fake_upstream(reply);
        let base = open_route(
            "s-e2e",
            &format!("http://127.0.0.1:{port}/v1"),
            root.to_str().unwrap(),
        )
        .unwrap();
        let body = serde_json::json!({ "tools": [{ "type": "function", "name": "exec_command" }], "input": [], "stream": true });
        let response = ureq::post(&format!("{base}/responses"))
            .set("content-type", "application/json")
            .send_string(&body.to_string())
            .unwrap();
        let mut text = String::new();
        response.into_reader().read_to_string(&mut text).unwrap();
        let sent = received.recv().unwrap();
        assert!(sent.starts_with("POST /v1/responses\n"), "{sent}");
        assert!(
            sent.contains("\"edit_file\"") && sent.contains("\"write_file\""),
            "{sent}"
        );
        assert!(!text.contains("edit_file"), "{text}");
        assert!(
            text.contains("exec_command") && text.contains("apply_patch <<'MONOCODE_EDIT_"),
            "{text}"
        );
        assert!(text.contains(r#"+    return \\\"hello\\\""#), "{text}");
        close_route("s-e2e");
    }

    #[test]
    fn an_unreachable_model_server_is_an_error_not_a_hang() {
        // A port nothing listens on, as when the server is down or a firewall
        // refuses the connection.
        let closed = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        let base = open_route(
            "s-down",
            &format!("http://127.0.0.1:{port}/v1"),
            std::env::temp_dir().to_str().unwrap(),
        )
        .unwrap();
        let started = std::time::Instant::now();
        let error = ureq::post(&format!("{base}/responses"))
            .send_string("{}")
            .unwrap_err();
        assert!(matches!(error, ureq::Error::Status(502, _)), "{error:?}");
        assert!(started.elapsed() < Duration::from_secs(15));
        close_route("s-down");
    }

    #[test]
    fn a_request_naming_another_host_is_refused() {
        let base = open_route(
            "s-host",
            "http://127.0.0.1:9/v1",
            std::env::temp_dir().to_str().unwrap(),
        )
        .unwrap();
        let error = ureq::post(&format!("{base}/responses"))
            .set("host", "evil.example:80")
            .send_string("{}")
            .unwrap_err();
        assert!(matches!(error, ureq::Error::Status(403, _)), "{error:?}");
        let missing = ureq::get(&base.replace("/s/", "/s/0")).call().unwrap_err();
        assert!(
            matches!(missing, ureq::Error::Status(404, _)),
            "{missing:?}"
        );
        close_route("s-host");
    }
}
