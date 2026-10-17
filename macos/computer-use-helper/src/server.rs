//! The helper's socket: newline-delimited JSON with MonoCode.
//!
//! Requests carry an `id` and an `op`; replies carry the same `id` and `ok`.
//! Events (`record`, `exited`) carry `event` and no `id`.
//!
//! | op | takes | answers |
//! |---|---|---|
//! | `hello` | `version` | `helperVersion`, `driver` (found or not) |
//! | `start` | `runtime`, `manifest` | `pid` |
//! | `tools` | `runtime` | `tools` |
//! | `call` | `runtime`, `name`, `arguments` | `result` |
//! | `stop` | `runtime` | `ended`, `releasedButtons`, `warning` |
//! | `resolve` | `query` | `app` or null |
//!
//! Each request runs on its own thread, so a stop never waits behind a
//! running call: it signals the runtime's processes first, which ends the
//! call, then takes the lock to release the mouse.

use std::collections::HashMap;
use std::io::{BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::apps::{self, App};
use crate::lines::read_line_capped;
use crate::runtime::{self, Runtimes};
use crate::stop::Mouse;

pub const PROTOCOL_VERSION: u64 = 1;
/// The largest request line: a manifest or a call's arguments.
const MAX_REQUEST: usize = 1024 * 1024;
const MAX_IN_FLIGHT: usize = 16;

pub struct Shared {
    pub runtimes: Mutex<Runtimes>,
    /// Each runtime's pids, readable while a call holds `runtimes`.
    pub pids: Mutex<HashMap<String, Vec<u32>>>,
    pub mouse: Box<dyn Mouse + Send + Sync>,
    pub home: PathBuf,
    pub driver_found: bool,
    apps: OnceLock<Vec<App>>,
    in_flight: AtomicUsize,
}

impl Shared {
    pub fn new(
        runtimes: Runtimes,
        mouse: Box<dyn Mouse + Send + Sync>,
        home: PathBuf,
        driver_found: bool,
    ) -> Self {
        Self {
            runtimes: Mutex::new(runtimes),
            pids: Mutex::new(HashMap::new()),
            mouse,
            home,
            driver_found,
            apps: OnceLock::new(),
            in_flight: AtomicUsize::new(0),
        }
    }

    #[cfg(test)]
    pub fn with_apps(self, apps: Vec<App>) -> Self {
        let _ = self.apps.set(apps);
        self
    }
}

type Writer = Arc<Mutex<UnixStream>>;

fn send(writer: &Writer, message: &Value) {
    if let Ok(mut stream) = writer.lock() {
        let mut line = message.to_string();
        line.push('\n');
        let _ = stream.write_all(line.as_bytes());
    }
}

fn ok(id: &Value, mut body: Value) -> Value {
    if let Some(map) = body.as_object_mut() {
        map.insert("id".into(), id.clone());
        map.insert("ok".into(), json!(true));
    }
    body
}

fn fail(id: &Value, message: impl Into<String>) -> Value {
    json!({"id": id, "ok": false, "error": message.into()})
}

fn str_field<'a>(request: &'a Value, key: &str) -> Option<&'a str> {
    request.get(key).and_then(Value::as_str)
}

/// One request, answered.
pub fn handle(shared: &Shared, request: &Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    if !(id.is_string() || id.is_u64()) {
        return fail(&Value::Null, "bad id");
    }
    match str_field(request, "op") {
        Some("hello") => ok(
            &id,
            json!({"helperVersion": env!("CARGO_PKG_VERSION"), "protocol": PROTOCOL_VERSION, "driver": shared.driver_found}),
        ),
        Some("start") => {
            let (Some(runtime), Some(manifest)) = (
                str_field(request, "runtime"),
                str_field(request, "manifest"),
            ) else {
                return fail(&id, "start needs runtime and manifest");
            };
            let Ok(mut runtimes) = shared.runtimes.lock() else {
                return fail(&id, "busy");
            };
            match runtimes.start(runtime, manifest, shared.mouse.as_ref()) {
                Ok(pid) => {
                    let pids = runtimes.pids(runtime);
                    if let Ok(mut map) = shared.pids.lock() {
                        map.insert(runtime.to_string(), pids);
                    }
                    ok(&id, json!({"pid": pid}))
                }
                Err(error) => fail(&id, error),
            }
        }
        Some("tools") => {
            let Some(runtime) = str_field(request, "runtime") else {
                return fail(&id, "tools needs runtime");
            };
            let Ok(mut runtimes) = shared.runtimes.lock() else {
                return fail(&id, "busy");
            };
            match runtimes.tools(runtime) {
                Ok(tools) => ok(&id, json!({"tools": tools})),
                Err(error) => fail(&id, error),
            }
        }
        Some("call") => {
            let (Some(runtime), Some(name)) =
                (str_field(request, "runtime"), str_field(request, "name"))
            else {
                return fail(&id, "call needs runtime and name");
            };
            let arguments = request
                .get("arguments")
                .cloned()
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({}));
            let Ok(mut runtimes) = shared.runtimes.lock() else {
                return fail(&id, "busy");
            };
            match runtimes.call(runtime, name, arguments) {
                Ok(result) => ok(&id, json!({"result": result})),
                Err(error) => fail(&id, error),
            }
        }
        Some("stop") => {
            let Some(runtime) = str_field(request, "runtime") else {
                return fail(&id, "stop needs runtime");
            };
            let report = stop_now(shared, runtime);
            ok(
                &id,
                json!({"ended": report.ended, "releasedButtons": report.released, "warning": report.warning}),
            )
        }
        Some("resolve") => {
            let Some(query) = str_field(request, "query") else {
                return fail(&id, "resolve needs query");
            };
            let list = shared.apps.get_or_init(|| apps::installed(&shared.home));
            ok(
                &id,
                json!({"app": apps::find(query, list).map(App::to_json)}),
            )
        }
        _ => fail(&id, "unknown op"),
    }
}

/// Ends a runtime without waiting for a call in flight: SIGTERM to its
/// processes at once, which ends any call, then the stop sequence.
pub fn stop_now(shared: &Shared, runtime: &str) -> crate::stop::StopReport {
    let pids = shared
        .pids
        .lock()
        .ok()
        .and_then(|mut map| map.remove(runtime))
        .unwrap_or_default();
    runtime::signal_all(&pids, 15);
    // A process that ignores SIGTERM is killed after the grace, before the
    // lock, so a call it holds cannot keep the stop waiting (review, 9).
    if !pids.is_empty() {
        std::thread::sleep(crate::stop::GRACE);
        runtime::signal_all(&pids, 9);
    }
    let mut runtimes = match shared.runtimes.lock() {
        Ok(runtimes) => runtimes,
        Err(poisoned) => poisoned.into_inner(),
    };
    runtimes.stop(runtime, shared.mouse.as_ref())
}

/// Serves one verified connection until it closes. Every runtime ends when
/// it does, so no grant outlives MonoCode's connection.
pub fn serve(shared: Arc<Shared>, stream: UnixStream) {
    let Ok(reader) = stream.try_clone() else {
        return;
    };
    let writer: Writer = Arc::new(Mutex::new(stream));
    let open = Arc::new(std::sync::atomic::AtomicBool::new(true));

    // Records and ended runtimes, every half second.
    {
        let shared = shared.clone();
        let writer = writer.clone();
        let open = open.clone();
        thread::spawn(move || {
            while open.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(500));
                let polled = match shared.runtimes.try_lock() {
                    Ok(mut runtimes) => runtimes.poll(),
                    // A call holds it: try on the next tick.
                    Err(_) => continue,
                };
                for (runtime, action) in polled.0 {
                    send(
                        &writer,
                        &json!({"event": "record", "runtime": runtime, "action": action}),
                    );
                }
                for (runtime, code) in polled.1 {
                    if let Ok(mut map) = shared.pids.lock() {
                        map.remove(&runtime);
                    }
                    send(
                        &writer,
                        &json!({"event": "exited", "runtime": runtime, "code": code}),
                    );
                }
            }
        });
    }

    let mut reader = BufReader::new(reader);
    loop {
        let line = match read_line_capped(&mut reader, MAX_REQUEST) {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                send(&writer, &fail(&Value::Null, "request too large"));
                continue;
            }
            Err(_) => break,
        };
        let Ok(request) = serde_json::from_slice::<Value>(&line) else {
            send(&writer, &fail(&Value::Null, "bad json"));
            continue;
        };
        if shared.in_flight.fetch_add(1, Ordering::SeqCst) >= MAX_IN_FLIGHT {
            shared.in_flight.fetch_sub(1, Ordering::SeqCst);
            let id = request.get("id").cloned().unwrap_or(Value::Null);
            send(&writer, &fail(&id, "too many requests at once"));
            continue;
        }
        let shared = shared.clone();
        let writer = writer.clone();
        thread::spawn(move || {
            let reply = handle(&shared, &request);
            shared.in_flight.fetch_sub(1, Ordering::SeqCst);
            send(&writer, &reply);
        });
    }
    open.store(false, Ordering::SeqCst);
    let ids = shared
        .runtimes
        .lock()
        .map(|r| r.running_ids())
        .unwrap_or_default();
    for id in ids {
        stop_now(&shared, &id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stop::Button;
    use std::fs;

    struct StillMouse;
    impl Mouse for StillMouse {
        fn held(&self, _button: Button) -> Option<bool> {
            Some(false)
        }
        fn release(&self, _button: Button) -> bool {
            true
        }
    }

    fn shared(name: &str) -> (PathBuf, Arc<Shared>) {
        let root = std::env::temp_dir().join(format!("cu-srv-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let runtimes = Runtimes::new(
            root.join("no-driver"),
            root.join("data"),
            root.join("s"),
            root.clone(),
        );
        let shared =
            Shared::new(runtimes, Box::new(StillMouse), root.clone(), false).with_apps(vec![App {
                bundle_id: "com.apple.calculator".into(),
                name: Some("Calculator".into()),
                path: "/System/Applications/Calculator.app".into(),
            }]);
        (root, Arc::new(shared))
    }

    #[test]
    fn answers_each_op_by_id() {
        let (root, shared) = shared("ops");
        let hello = handle(&shared, &json!({"id": 1, "op": "hello", "version": 1}));
        assert_eq!(hello["ok"], true);
        assert_eq!(hello["id"], 1);
        assert_eq!(hello["driver"], false);
        let resolved = handle(
            &shared,
            &json!({"id": "r", "op": "resolve", "query": "calculator"}),
        );
        assert_eq!(resolved["app"]["bundleId"], "com.apple.calculator");
        let none = handle(&shared, &json!({"id": 2, "op": "resolve", "query": "Nope"}));
        assert!(none["app"].is_null());
        let start = handle(
            &shared,
            &json!({"id": 3, "op": "start", "runtime": "rt", "manifest": "# Written by MonoCode for one chat. Do not edit.\nversion: 3\n  desktop:\n    display: false\n"}),
        );
        assert_eq!(start["ok"], false, "no driver");
        assert!(start["error"].as_str().unwrap().contains("missing"));
        let call = handle(
            &shared,
            &json!({"id": 4, "op": "call", "runtime": "rt", "name": "click"}),
        );
        assert_eq!(call["ok"], false);
        let stop = handle(&shared, &json!({"id": 5, "op": "stop", "runtime": "rt"}));
        assert_eq!(stop["ok"], true);
        assert_eq!(stop["ended"], true);
        assert_eq!(
            handle(&shared, &json!({"id": 6, "op": "rm -rf"}))["ok"],
            false
        );
        assert_eq!(
            handle(&shared, &json!({"id": {"a": 1}, "op": "hello"}))["ok"],
            false
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_connection_answers_lines_and_survives_junk() {
        use std::io::BufRead;
        let (root, shared) = shared("conn");
        let (ours, theirs) = UnixStream::pair().unwrap();
        let server = thread::spawn(move || serve(shared, theirs));
        let mut writer = ours.try_clone().unwrap();
        writer
            .write_all(b"not json\n{\"id\":7,\"op\":\"hello\"}\n")
            .unwrap();
        let mut reader = BufReader::new(ours.try_clone().unwrap());
        let mut replies = Vec::new();
        for _ in 0..2 {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            replies.push(serde_json::from_str::<Value>(&line).unwrap());
        }
        assert!(replies.iter().any(|r| r["error"] == "bad json"));
        assert!(replies.iter().any(|r| r["id"] == 7 && r["ok"] == true));
        drop(writer);
        ours.shutdown(std::net::Shutdown::Both).unwrap();
        server.join().unwrap();
        let _ = fs::remove_dir_all(&root);
    }
}
