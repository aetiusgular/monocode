//! One Cua runtime per chat: the embedded daemon, bounded by that chat's
//! manifest, and the MCP proxy the helper talks through.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::driver::{mcp_launch, runtime_id, serve_launch, Launch};
use crate::mcp_client::McpClient;
use crate::recording::Scanner;
use crate::stop::{self, Mouse, Processes, StopReport};
use crate::tools::relayable;

/// The most runtimes at once, one per chat.
pub const MAX_RUNTIMES: usize = 8;
/// The largest manifest taken from MonoCode.
pub const MAX_MANIFEST: usize = 64 * 1024;
const SOCKET_WAIT: Duration = Duration::from_secs(8);
const INIT_TIMEOUT: Duration = Duration::from_secs(20);
pub const CALL_TIMEOUT: Duration = Duration::from_secs(120);

struct Runtime {
    serve: Child,
    proxy: Child,
    client: McpClient,
    scanner: Scanner,
    files: Vec<PathBuf>,
}

pub struct Runtimes {
    driver: PathBuf,
    /// Manifests and recordings, under MonoCode's data folder.
    data: PathBuf,
    /// Sockets: a short private folder, since a socket path is capped at 104
    /// bytes on macOS.
    sockets: PathBuf,
    home: PathBuf,
    running: HashMap<String, Runtime>,
}

fn spawn(launch: &Launch, piped: bool) -> std::io::Result<Child> {
    let mut command = Command::new(&launch.program);
    command.args(&launch.args).env_clear();
    for (key, value) in &launch.env {
        command.env(key, value);
    }
    if piped {
        command.stdin(Stdio::piped()).stdout(Stdio::piped());
    } else {
        command.stdin(Stdio::null()).stdout(Stdio::null());
    }
    command.stderr(Stdio::null()).spawn()
}

/// Writes a file only this user can read, replacing any file or link there.
fn write_private(path: &Path, text: &str) -> Result<(), String> {
    let _ = fs::remove_file(path);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(text.as_bytes()).map_err(|e| e.to_string())
}

pub fn private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if !meta.is_dir() {
            return Err(format!("{} is not a folder", path.display()));
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

impl Runtimes {
    pub fn new(driver: PathBuf, data: PathBuf, sockets: PathBuf, home: PathBuf) -> Self {
        Self {
            driver,
            data,
            sockets,
            home,
            running: HashMap::new(),
        }
    }

    /// The pids of a runtime's processes, so a stop can end them while a
    /// call holds the runtime.
    pub fn pids(&self, id: &str) -> Vec<u32> {
        self.running
            .get(id)
            .map(|runtime| vec![runtime.proxy.id(), runtime.serve.id()])
            .unwrap_or_default()
    }

    pub fn running_ids(&self) -> Vec<String> {
        self.running.keys().cloned().collect()
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.running.contains_key(id)
    }

    /// Starts a runtime for `id` with this manifest, replacing one already
    /// running under that id. Returns the daemon's pid.
    pub fn start(&mut self, id: &str, manifest: &str, mouse: &dyn Mouse) -> Result<u32, String> {
        let id = runtime_id(id).ok_or("Bad runtime id")?.to_string();
        if !manifest_acceptable(manifest) {
            return Err("Bad manifest".into());
        }
        if self.running.contains_key(&id) {
            self.stop(&id, mouse);
        }
        if self.running.len() >= MAX_RUNTIMES {
            return Err(format!(
                "At most {MAX_RUNTIMES} chats can use the computer at once."
            ));
        }
        if !self.driver.is_file() {
            return Err(format!(
                "Cua Driver is missing at {}",
                self.driver.display()
            ));
        }
        private_dir(&self.data)?;
        private_dir(&self.sockets)?;
        let manifest_path = self.data.join(format!("rt-{id}.yaml"));
        let socket = self.sockets.join(format!("{id}.sock"));
        let recordings = self.data.join("recordings").join(&id);
        write_private(&manifest_path, manifest)?;
        let _ = fs::remove_file(&socket);
        private_dir(&recordings)?;

        let mut serve = spawn(
            &serve_launch(&self.driver, &socket, &manifest_path, &self.home),
            false,
        )
        .map_err(|e| format!("Cua Driver did not start: {e}"))?;
        let started = Instant::now();
        while !socket.exists() {
            if started.elapsed() > SOCKET_WAIT || serve.try_wait().ok().flatten().is_some() {
                let _ = serve.kill();
                let _ = serve.wait();
                return Err("Cua Driver did not open its socket.".into());
            }
            thread::sleep(Duration::from_millis(50));
        }
        let mut proxy = match spawn(&mcp_launch(&self.driver, &socket, &self.home), true) {
            Ok(proxy) => proxy,
            Err(error) => {
                let _ = serve.kill();
                let _ = serve.wait();
                return Err(format!("The Cua Driver proxy did not start: {error}"));
            }
        };
        let (Some(stdin), Some(stdout)) = (proxy.stdin.take(), proxy.stdout.take()) else {
            let _ = proxy.kill();
            let _ = serve.kill();
            return Err("The Cua Driver proxy has no pipes.".into());
        };
        let mut client = McpClient::new(stdout, stdin);
        let pid = serve.id();
        let mut runtime = Runtime {
            serve,
            proxy,
            client: McpClient::new(std::io::empty(), std::io::sink()),
            scanner: Scanner::new(recordings.clone()),
            files: vec![manifest_path, socket],
        };
        if let Err(error) = client.initialize(INIT_TIMEOUT) {
            end_processes(&mut runtime, stop::GRACE);
            cleanup(&runtime);
            return Err(error);
        }
        // C7: screenshots on, the accessibility tree off. A runtime that
        // cannot record still runs; the log then has the tool calls only.
        let _ = client.request(
            "tools/call",
            json!({"name": "start_recording", "arguments": {
                "output_dir": recordings.to_string_lossy(),
                "include_accessibility_tree": false,
                "record_video": false
            }}),
            INIT_TIMEOUT,
        );
        runtime.client = client;
        self.running.insert(id, runtime);
        Ok(pid)
    }

    /// The runtime's tools, only those MonoCode may relay.
    pub fn tools(&mut self, id: &str) -> Result<Vec<Value>, String> {
        let runtime = self.running.get_mut(id).ok_or("Not running")?;
        let result = runtime
            .client
            .request("tools/list", json!({}), INIT_TIMEOUT)?;
        Ok(result
            .get("tools")
            .and_then(Value::as_array)
            .map(|tools| {
                tools
                    .iter()
                    .filter(|tool| {
                        tool.get("name")
                            .and_then(Value::as_str)
                            .is_some_and(relayable)
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default())
    }

    pub fn call(&mut self, id: &str, name: &str, arguments: Value) -> Result<Value, String> {
        if !relayable(name) {
            return Err(format!("{name} is not relayed."));
        }
        let runtime = self.running.get_mut(id).ok_or("Not running")?;
        runtime.client.request(
            "tools/call",
            json!({"name": name, "arguments": arguments}),
            CALL_TIMEOUT,
        )
    }

    pub fn stop(&mut self, id: &str, mouse: &dyn Mouse) -> StopReport {
        let Some(mut runtime) = self.running.remove(id) else {
            // Nothing running, but a button may still be held from before.
            return stop::stop(&mut NoProcesses, mouse);
        };
        let report = stop::stop(&mut RuntimeProcesses(&mut runtime), mouse);
        cleanup(&runtime);
        report
    }

    pub fn stop_all(&mut self, mouse: &dyn Mouse) {
        let ids: Vec<String> = self.running.keys().cloned().collect();
        for id in ids {
            self.stop(&id, mouse);
        }
    }

    /// New action records and runtimes that ended on their own.
    pub fn poll(&mut self) -> Polled {
        let mut records = Vec::new();
        let mut exited = Vec::new();
        for (id, runtime) in &mut self.running {
            for record in runtime.scanner.scan() {
                records.push((id.clone(), record));
            }
            if let Ok(Some(status)) = runtime.serve.try_wait() {
                exited.push((id.clone(), status.code()));
            }
        }
        for (id, _) in &exited {
            if let Some(mut runtime) = self.running.remove(id) {
                end_processes(&mut runtime, Duration::from_millis(200));
                cleanup(&runtime);
            }
        }
        (records, exited)
    }
}

/// A second look at what MonoCode sent: a bounded v3 manifest that never
/// names MonoCode, never shows the whole display and never asks for another
/// mode. MonoCode writes it; this only stops a mistake from reaching Cua.
pub fn manifest_acceptable(manifest: &str) -> bool {
    let lower = manifest.to_ascii_lowercase();
    manifest.len() <= MAX_MANIFEST
        && lower.contains("version: 3\n")
        && !lower.contains("com.monocode")
        && !lower.contains("display: true")
        && !lower.contains("unrestricted")
        && !lower.contains("mode:")
}

/// New action records, and runtimes that ended with their exit code.
pub type Polled = (Vec<(String, Value)>, Vec<(String, Option<i32>)>);

struct NoProcesses;
impl Processes for NoProcesses {
    fn end(&mut self, _grace: Duration) -> bool {
        true
    }
}

struct RuntimeProcesses<'a>(&'a mut Runtime);
impl Processes for RuntimeProcesses<'_> {
    fn end(&mut self, grace: Duration) -> bool {
        end_processes(self.0, grace)
    }
}

fn end_processes(runtime: &mut Runtime, grace: Duration) -> bool {
    let mut ended = true;
    for child in [&mut runtime.proxy, &mut runtime.serve] {
        ended &= end_child(child, grace);
    }
    ended
}

fn end_child(child: &mut Child, grace: Duration) -> bool {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return true;
    }
    #[cfg(unix)]
    unsafe {
        // SIGTERM first, so the driver can let go of what it holds.
        kill(child.id() as i32, 15);
    }
    let started = Instant::now();
    while started.elapsed() < grace {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return true;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let _ = child.kill();
    child.wait().is_ok()
}

#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}

/// Sends `signal` to each pid. Used by a stop that cannot wait for the lock.
pub fn signal_all(pids: &[u32], signal: i32) {
    #[cfg(unix)]
    for pid in pids {
        if *pid > 1 && *pid <= i32::MAX as u32 {
            unsafe {
                kill(*pid as i32, signal);
            }
        }
    }
}

fn cleanup(runtime: &Runtime) {
    for file in &runtime.files {
        let _ = fs::remove_file(file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stop::Button;

    struct StillMouse;
    impl Mouse for StillMouse {
        fn held(&self, _button: Button) -> Option<bool> {
            Some(false)
        }
        fn release(&self, _button: Button) -> bool {
            true
        }
    }

    const FAKE_DRIVER: &str = r#"#!/bin/sh
# A stand-in for cua-driver: `serve` makes its socket path and waits;
# `mcp` answers each request line with a canned reply.
case "$1" in
serve)
  [ "$CUA_DRIVER_PERMISSION_MODE" = bounded ] || exit 3
  [ "$CUA_DRIVER_RS_TELEMETRY_ENABLED" = false ] || exit 4
  : > "$4"
  exec sleep 60 ;;
mcp)
  while IFS= read -r line; do
    id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
    [ -z "$id" ] && continue
    case "$line" in
      *'"tools/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"click"},{"name":"get_desktop_state"},{"name":"start_recording"},{"name":"set_config"}]}}\n' "$id" ;;
      *) printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"ok"}]}}\n' "$id" ;;
    esac
  done ;;
esac
"#;

    fn setup(name: &str) -> (PathBuf, Runtimes) {
        let root = std::env::temp_dir().join(format!("cu-rt-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let driver = root.join("cua-driver");
        fs::write(&driver, FAKE_DRIVER).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&driver, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let runtimes = Runtimes::new(driver, root.join("data"), root.join("s"), root.clone());
        (root, runtimes)
    }

    const MANIFEST: &str = "version: 3\nexpires_after: \"8h\"\n";

    #[test]
    fn starts_lists_only_relayable_tools_calls_and_stops() {
        let (root, mut runtimes) = setup("main");
        let pid = runtimes.start("rt1", MANIFEST, &StillMouse).unwrap();
        assert!(pid > 0);
        assert!(runtimes.is_running("rt1"));
        let manifest = root.join("data").join("rt-rt1.yaml");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&manifest).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let tools = runtimes.tools("rt1").unwrap();
        let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        assert_eq!(names, vec!["click"]);
        let result = runtimes.call("rt1", "click", json!({"x": 1})).unwrap();
        assert_eq!(result["content"][0]["text"], "ok");
        assert!(runtimes.call("rt1", "start_recording", json!({})).is_err());
        assert!(runtimes.call("rt1", "set_config", json!({})).is_err());
        let report = runtimes.stop("rt1", &StillMouse);
        assert!(report.ended);
        assert!(!runtimes.is_running("rt1"));
        assert!(!manifest.exists(), "the manifest goes with the runtime");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_bad_ids_and_manifests() {
        let (root, mut runtimes) = setup("bad");
        assert!(runtimes.start("../x", MANIFEST, &StillMouse).is_err());
        assert!(runtimes
            .start("rt", "mode: unrestricted", &StillMouse)
            .is_err());
        assert!(runtimes
            .start("rt", &"x".repeat(MAX_MANIFEST + 1), &StillMouse)
            .is_err());
        for bad in [
            "version: 3\n  - bundle_id: \"com.monocode.desktop\"\n",
            "version: 3\n  desktop:\n    display: true\n",
            "version: 3\nmode: unrestricted\n",
        ] {
            assert!(runtimes.start("rt", bad, &StillMouse).is_err(), "{bad}");
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_driver_is_a_plain_error() {
        let (root, mut runtimes) = setup("missing");
        fs::remove_file(root.join("cua-driver")).unwrap();
        let error = runtimes.start("rt", MANIFEST, &StillMouse).unwrap_err();
        assert!(error.contains("missing"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn restarting_replaces_the_runtime() {
        let (root, mut runtimes) = setup("restart");
        let first = runtimes.start("rt", MANIFEST, &StillMouse).unwrap();
        let second = runtimes.start("rt", MANIFEST, &StillMouse).unwrap();
        assert_ne!(first, second);
        runtimes.stop_all(&StillMouse);
        assert!(!runtimes.is_running("rt"));
        let _ = fs::remove_dir_all(&root);
    }
}
