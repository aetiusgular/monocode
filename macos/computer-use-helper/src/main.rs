//! MonoCode Computer Use: the helper app that holds Accessibility and Screen
//! Recording and embeds Cua Driver (wave 3, lane C, item C1).
//!
//! - MonoCode starts it through Launch Services (`open -n -g -a`), so macOS
//!   credits the grants to this app, not to MonoCode or a harness. No agent
//!   shell inherits them (note W, section 4).
//! - It listens on one Unix socket MonoCode names, takes one caller, and
//!   checks that caller's code signature against MonoCode's (`caller.rs`).
//! - Per chat it starts `cua-driver serve --embedded` itself, bounded by the
//!   chat's manifest, with Cua's telemetry and update check off.
//! - When MonoCode's connection closes, or MonoCode exits, every runtime ends
//!   and the helper quits.
//!
//! Usage: `monocode-computer-use-helper serve --socket <path> --monocode-pid
//! <pid> --data <dir>`. A debug build also takes `--driver <path>`; a release
//! build uses the `cua-driver` beside its own executable only.

// Off macOS only the tests use most of this crate.
#![cfg_attr(not(target_os = "macos"), allow(dead_code, unused_imports))]

mod apps;
mod caller;
mod driver;
mod lines;
#[cfg(target_os = "macos")]
mod macos;
mod mcp_client;
mod recording;
mod runtime;
mod server;
mod stop;
mod tools;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, PartialEq, Eq)]
struct Args {
    socket: PathBuf,
    monocode_pid: i32,
    data: PathBuf,
    driver: Option<PathBuf>,
}

fn parse_args(args: &[String], debug: bool) -> Result<Args, String> {
    if args.first().map(String::as_str) != Some("serve") {
        return Err("usage: serve --socket <path> --monocode-pid <pid> --data <dir>".into());
    }
    let mut socket = None;
    let mut pid = None;
    let mut data = None;
    let mut driver = None;
    let mut rest = args[1..].iter();
    while let Some(flag) = rest.next() {
        let value = rest.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--socket" => socket = Some(PathBuf::from(value)),
            "--monocode-pid" => pid = Some(value.parse::<i32>().map_err(|_| "bad pid")?),
            "--data" => data = Some(PathBuf::from(value)),
            "--driver" if debug => driver = Some(PathBuf::from(value)),
            other => return Err(format!("unknown flag {other}")),
        }
    }
    let socket = socket.ok_or("--socket is required")?;
    let data = data.ok_or("--data is required")?;
    let monocode_pid = pid
        .filter(|pid| *pid > 1)
        .ok_or("--monocode-pid is required")?;
    if !socket.is_absolute() || !data.is_absolute() {
        return Err("paths must be absolute".into());
    }
    if socket.as_os_str().len() > 100 {
        return Err("socket path too long".into());
    }
    Ok(Args {
        socket,
        monocode_pid,
        data,
        driver,
    })
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse_args(&argv, cfg!(debug_assertions)) {
        Ok(args) => args,
        Err(error) => {
            eprintln!("monocode-computer-use-helper: {error}");
            std::process::exit(2);
        }
    };
    std::process::exit(run(args));
}

#[cfg(not(target_os = "macos"))]
fn run(_args: Args) -> i32 {
    eprintln!("monocode-computer-use-helper: macOS only");
    2
}

#[cfg(target_os = "macos")]
fn run(args: Args) -> i32 {
    use std::os::unix::io::AsRawFd;
    use std::os::unix::net::UnixListener;

    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    let driver = args.driver.clone().unwrap_or_else(|| {
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join("cua-driver")))
            .unwrap_or_else(|| PathBuf::from("/nonexistent/cua-driver"))
    });
    let Some(socket_dir) = args.socket.parent().map(PathBuf::from) else {
        return 2;
    };
    if runtime::private_dir(&socket_dir).is_err() {
        return 2;
    }
    // Sockets for the runtimes beside MonoCode's, in the same private folder.
    let runtimes = runtime::Runtimes::new(
        driver.clone(),
        args.data.clone(),
        socket_dir.join("rt"),
        home.clone(),
    );
    let shared = Arc::new(server::Shared::new(
        runtimes,
        Box::new(macos::SystemMouse),
        home,
        driver.is_file(),
    ));

    let _ = std::fs::remove_file(&args.socket);
    let listener = match UnixListener::bind(&args.socket) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("monocode-computer-use-helper: cannot listen: {error}");
            return 2;
        }
    };
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&args.socket, std::fs::Permissions::from_mode(0o600));
    }

    // Quit when MonoCode is gone, ending every runtime first.
    {
        let shared = shared.clone();
        let pid = args.monocode_pid;
        let socket = args.socket.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(2));
            if !process_alive(pid) {
                let ids = shared
                    .runtimes
                    .lock()
                    .map(|r| r.running_ids())
                    .unwrap_or_default();
                for id in ids {
                    server::stop_now(&shared, &id);
                }
                let _ = std::fs::remove_file(&socket);
                std::process::exit(0);
            }
        });
    }

    let requirement = caller::built_requirement();
    let started = Instant::now();
    listener.set_nonblocking(true).ok();
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false).ok();
                let fd = stream.as_raw_fd();
                let signed = requirement.and_then(|req| macos::peer_meets(fd, req));
                let verdict = caller::decide(
                    signed,
                    macos::peer_pid(fd),
                    args.monocode_pid,
                    cfg!(debug_assertions),
                );
                match verdict {
                    caller::Verdict::Allow => {
                        if requirement.is_none() {
                            eprintln!("monocode-computer-use-helper: debug build, caller checked by pid only");
                        }
                        server::serve(shared.clone(), stream);
                        // One MonoCode connection per helper run.
                        let _ = std::fs::remove_file(&args.socket);
                        return 0;
                    }
                    caller::Verdict::Refuse(why) => {
                        eprintln!("monocode-computer-use-helper: refused a caller: {why}");
                        drop(stream);
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if started.elapsed() > Duration::from_secs(60) {
                    let _ = std::fs::remove_file(&args.socket);
                    return 0;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return 2,
        }
    }
}

#[cfg(target_os = "macos")]
fn process_alive(pid: i32) -> bool {
    extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    unsafe { kill(pid, 0) == 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_the_serve_command() {
        let parsed = parse_args(
            &args(&[
                "serve",
                "--socket",
                "/t/s",
                "--monocode-pid",
                "42",
                "--data",
                "/d",
            ]),
            false,
        )
        .unwrap();
        assert_eq!(parsed.monocode_pid, 42);
        assert_eq!(parsed.driver, None);
    }

    #[test]
    fn a_release_build_takes_no_driver_path() {
        let list = args(&[
            "serve",
            "--socket",
            "/t/s",
            "--monocode-pid",
            "42",
            "--data",
            "/d",
            "--driver",
            "/tmp/x",
        ]);
        assert!(parse_args(&list, false).is_err());
        assert_eq!(
            parse_args(&list, true).unwrap().driver,
            Some(PathBuf::from("/tmp/x"))
        );
    }

    #[test]
    fn refuses_bad_arguments() {
        for list in [
            vec![],
            vec!["mcp"],
            vec![
                "serve",
                "--socket",
                "s",
                "--monocode-pid",
                "42",
                "--data",
                "/d",
            ],
            vec![
                "serve",
                "--socket",
                "/t/s",
                "--monocode-pid",
                "1",
                "--data",
                "/d",
            ],
            vec![
                "serve",
                "--socket",
                "/t/s",
                "--monocode-pid",
                "x",
                "--data",
                "/d",
            ],
            vec!["serve", "--socket", "/t/s", "--data", "/d"],
            vec!["serve", "--socket"],
        ] {
            assert!(parse_args(&args(&list), true).is_err(), "{list:?}");
        }
        let long = format!("/{}", "x".repeat(120));
        assert!(parse_args(
            &args(&[
                "serve",
                "--socket",
                &long,
                "--monocode-pid",
                "9",
                "--data",
                "/d"
            ]),
            true
        )
        .is_err());
    }
}
