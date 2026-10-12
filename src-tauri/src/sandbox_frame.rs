//! The sandboxed frame: a URI scheme that serves HTML the user opened, for an
//! `<iframe sandbox="allow-scripts">` in the main window.
//!
//! A registered scheme counts as a local origin, and a top-level document on
//! it could reach the app's commands. So every layer here assumes the others
//! may fail:
//!
//! - Content is held in memory under a random token. The scheme serves nothing
//!   else: no file paths, no directory, no query strings.
//! - Every response carries a CSP with `sandbox allow-scripts`, which gives the
//!   document an opaque origin even if it is ever loaded outside the iframe,
//!   and blocks every network fetch, form, frame and worker.
//! - A request that says it is a top-level document (`Sec-Fetch-Dest:
//!   document`) is refused.
//! - The navigation guard lets the scheme load only for a live token. On macOS
//!   wry calls the guard for every frame, so it cannot refuse the scheme
//!   outright without breaking the iframe itself.

use std::collections::VecDeque;
use std::sync::Mutex;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::{Manager, Runtime, State, Url};

/// The scheme name. Windows and Android serve it as `http://mcpreview.localhost`.
pub const SCHEME: &str = "mcpreview";

/// Largest document held, in bytes. A generated report fits; a stray binary
/// does not get copied into memory.
pub const MAX_DOCUMENT_BYTES: usize = 10 * 1024 * 1024;
/// Documents kept at once. The oldest goes first.
pub const MAX_DOCUMENTS: usize = 32;
/// Bytes kept across all documents.
pub const MAX_TOTAL_BYTES: usize = 48 * 1024 * 1024;

/// The policy every response carries. Inline script and style run; nothing
/// leaves the frame.
pub const FRAME_CSP: &str = "sandbox allow-scripts; default-src 'none'; \
script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; \
font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; \
child-src 'none'; worker-src 'none'; manifest-src 'none'; object-src 'none'; \
form-action 'none'; base-uri 'none'";

struct Entry {
    token: String,
    html: Vec<u8>,
}

/// In-memory documents, oldest first.
#[derive(Default)]
pub struct FrameStore {
    entries: Mutex<VecDeque<Entry>>,
}

impl FrameStore {
    pub fn put(&self, html: String) -> Result<String, String> {
        let bytes = html.into_bytes();
        if bytes.len() > MAX_DOCUMENT_BYTES {
            return Err(format!(
                "The document is {} bytes. The preview holds at most {MAX_DOCUMENT_BYTES}.",
                bytes.len()
            ));
        }
        let token = new_token();
        let mut entries = self.entries.lock().map_err(|_| "Preview store poisoned")?;
        entries.push_back(Entry {
            token: token.clone(),
            html: bytes,
        });
        let mut total: usize = entries.iter().map(|entry| entry.html.len()).sum();
        while entries.len() > MAX_DOCUMENTS || (total > MAX_TOTAL_BYTES && entries.len() > 1) {
            if let Some(oldest) = entries.pop_front() {
                total -= oldest.html.len();
            }
        }
        Ok(token)
    }

    pub fn release(&self, token: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|entry| entry.token != token);
        }
    }

    pub fn contains(&self, token: &str) -> bool {
        self.entries
            .lock()
            .map(|entries| entries.iter().any(|entry| entry.token == token))
            .unwrap_or(false)
    }

    fn get(&self, token: &str) -> Option<Vec<u8>> {
        let entries = self.entries.lock().ok()?;
        entries
            .iter()
            .find(|entry| entry.token == token)
            .map(|entry| entry.html.clone())
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries
            .lock()
            .map(|entries| entries.len())
            .unwrap_or(0)
    }
}

/// 32 lowercase hex characters from a v4 UUID's 122 random bits.
fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// A token is exactly 32 lowercase hex characters, so a path can carry no
/// separator, dot, percent escape or anything else to interpret.
pub fn is_token(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The token a frame URL names, or `None` for anything that is not exactly
/// `<scheme>://localhost/<token>` or `http(s)://mcpreview.localhost/<token>`
/// with no query or fragment.
pub fn token_from_url(url: &Url) -> Option<String> {
    let scheme_form = url.scheme() == SCHEME && url.host_str() == Some("localhost");
    let windows_form = matches!(url.scheme(), "http" | "https")
        && url.host_str() == Some(&format!("{SCHEME}.localhost") as &str);
    if !(scheme_form || windows_form) {
        return None;
    }
    if url.query().is_some() || url.fragment().is_some() || url.port().is_some() {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let token = url.path().strip_prefix('/')?;
    is_token(token).then(|| token.to_string())
}

/// Whether a URL is one this module serves, live token or not.
fn is_frame_url(url: &Url) -> bool {
    url.scheme() == SCHEME
        || (matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some(&format!("{SCHEME}.localhost") as &str))
}

/// The navigation guard's decision. Every URL outside this scheme is left to
/// the rest of the app.
pub fn navigation_allowed(url: &Url, live: impl Fn(&str) -> bool) -> bool {
    if !is_frame_url(url) {
        return true;
    }
    match token_from_url(url) {
        Some(token) => live(&token),
        None => false,
    }
}

/// Answer one request on the scheme.
pub fn respond(store: &FrameStore, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != tauri::http::Method::GET {
        return refuse(StatusCode::METHOD_NOT_ALLOWED);
    }
    // A top-level load is the one case the iframe's sandbox cannot cover.
    let dest = request
        .headers()
        .get("sec-fetch-dest")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if dest.eq_ignore_ascii_case("document") {
        return refuse(StatusCode::FORBIDDEN);
    }
    let Ok(url) = Url::parse(&request.uri().to_string()) else {
        return refuse(StatusCode::BAD_REQUEST);
    };
    let Some(token) = token_from_url(&url) else {
        return refuse(StatusCode::NOT_FOUND);
    };
    let Some(html) = store.get(&token) else {
        return refuse(StatusCode::NOT_FOUND);
    };
    with_headers(Response::builder().status(StatusCode::OK))
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(html)
        .unwrap_or_else(|_| refuse(StatusCode::INTERNAL_SERVER_ERROR))
}

fn with_headers(builder: tauri::http::response::Builder) -> tauri::http::response::Builder {
    builder
        .header(header::CONTENT_SECURITY_POLICY, FRAME_CSP)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
}

fn refuse(status: StatusCode) -> Response<Vec<u8>> {
    with_headers(Response::builder().status(status))
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Vec::new())
        .expect("static response")
}

/// The navigation guard, as a plugin so it sits beside the app's other hooks.
pub fn navigation_guard<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("sandbox-frame-guard")
        .on_navigation(|webview, url| {
            let store = webview.state::<FrameStore>();
            navigation_allowed(url, |token| store.contains(token))
        })
        .build()
}

/// Hold a document for the frame and return its token.
#[tauri::command]
pub fn sandbox_frame_put(store: State<FrameStore>, html: String) -> Result<String, String> {
    store.put(html)
}

/// Drop a document once its frame is gone.
#[tauri::command]
pub fn sandbox_frame_release(store: State<FrameStore>, token: String) {
    if is_token(&token) {
        store.release(&token);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(uri: &str) -> Request<Vec<u8>> {
        Request::builder().uri(uri).body(Vec::new()).unwrap()
    }

    #[test]
    fn serves_a_live_token_with_the_frame_policy() {
        let store = FrameStore::default();
        let token = store.put("<p>hi</p>".into()).unwrap();
        let response = respond(&store, &request(&format!("mcpreview://localhost/{token}")));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), b"<p>hi</p>");
        let csp = response.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap();
        assert!(csp.starts_with("sandbox allow-scripts;"));
        assert!(csp.contains("connect-src 'none'"));
        assert!(!csp.contains("allow-same-origin"));
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
    }

    #[test]
    fn serves_the_windows_form() {
        let store = FrameStore::default();
        let token = store.put("x".into()).unwrap();
        let response = respond(
            &store,
            &request(&format!("http://mcpreview.localhost/{token}")),
        );
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn refuses_unknown_released_and_malformed_tokens() {
        let store = FrameStore::default();
        let token = store.put("x".into()).unwrap();
        for uri in [
            "mcpreview://localhost/0123456789abcdef0123456789abcdef".to_string(),
            format!("mcpreview://localhost/{token}?a=1"),
            format!("mcpreview://localhost/{token}/../etc/passwd"),
            format!("mcpreview://localhost/{}", token.to_uppercase()),
            format!("mcpreview://other/{token}"),
            "mcpreview://localhost/".to_string(),
            "mcpreview://localhost/%2e%2e%2fsecret".to_string(),
        ] {
            assert_eq!(
                respond(&store, &request(&uri)).status(),
                StatusCode::NOT_FOUND,
                "{uri}"
            );
        }
        store.release(&token);
        assert_eq!(
            respond(&store, &request(&format!("mcpreview://localhost/{token}"))).status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn refuses_top_level_loads_and_other_methods() {
        let store = FrameStore::default();
        let token = store.put("x".into()).unwrap();
        let uri = format!("mcpreview://localhost/{token}");
        let top = Request::builder()
            .uri(&uri)
            .header("Sec-Fetch-Dest", "document")
            .body(Vec::new())
            .unwrap();
        assert_eq!(respond(&store, &top).status(), StatusCode::FORBIDDEN);
        let framed = Request::builder()
            .uri(&uri)
            .header("Sec-Fetch-Dest", "iframe")
            .body(Vec::new())
            .unwrap();
        assert_eq!(respond(&store, &framed).status(), StatusCode::OK);
        let post = Request::builder()
            .method("POST")
            .uri(&uri)
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            respond(&store, &post).status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }

    #[test]
    fn refusals_carry_the_policy_too() {
        let store = FrameStore::default();
        let response = respond(&store, &request("mcpreview://localhost/nope"));
        assert!(response
            .headers()
            .contains_key(header::CONTENT_SECURITY_POLICY));
    }

    #[test]
    fn bounds_size_and_count() {
        let store = FrameStore::default();
        assert!(store.put("a".repeat(MAX_DOCUMENT_BYTES + 1)).is_err());
        let first = store.put("first".into()).unwrap();
        for _ in 0..MAX_DOCUMENTS {
            store.put("x".into()).unwrap();
        }
        assert_eq!(store.len(), MAX_DOCUMENTS);
        assert!(!store.contains(&first));
        let big = "b".repeat(MAX_DOCUMENT_BYTES);
        for _ in 0..6 {
            store.put(big.clone()).unwrap();
        }
        let total: usize = store
            .entries
            .lock()
            .unwrap()
            .iter()
            .map(|entry| entry.html.len())
            .sum();
        assert!(total <= MAX_TOTAL_BYTES);
    }

    #[test]
    fn tokens_are_32_lowercase_hex() {
        let store = FrameStore::default();
        let token = store.put("x".into()).unwrap();
        assert!(is_token(&token));
        assert!(!is_token("../"));
        assert!(!is_token(&"g".repeat(32)));
        assert!(!is_token(&"a".repeat(31)));
    }

    #[test]
    fn guard_leaves_other_urls_alone_and_checks_frame_urls() {
        let live = "0123456789abcdef0123456789abcdef";
        let is_live = |token: &str| token == live;
        for url in [
            "tauri://localhost/index.html",
            "http://localhost:1420/",
            "https://example.com/",
            "asset://localhost/x",
        ] {
            assert!(
                navigation_allowed(&Url::parse(url).unwrap(), is_live),
                "{url}"
            );
        }
        assert!(navigation_allowed(
            &Url::parse(&format!("mcpreview://localhost/{live}")).unwrap(),
            is_live
        ));
        assert!(navigation_allowed(
            &Url::parse(&format!("http://mcpreview.localhost/{live}")).unwrap(),
            is_live
        ));
        for url in [
            "mcpreview://localhost/ffffffffffffffffffffffffffffffff".to_string(),
            format!("mcpreview://localhost/{live}#x"),
            format!("mcpreview://localhost/{live}?q"),
            format!("mcpreview://user@localhost/{live}"),
            "mcpreview://localhost/".to_string(),
            format!("http://mcpreview.localhost:8080/{live}"),
        ] {
            assert!(
                !navigation_allowed(&Url::parse(&url).unwrap(), is_live),
                "{url}"
            );
        }
    }
}
