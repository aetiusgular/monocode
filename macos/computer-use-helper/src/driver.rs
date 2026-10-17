//! How the helper starts Cua Driver for one runtime.
//!
//! From Cua's embedding guide (read 16 Oct 2026): the host spawns
//! `cua-driver serve --embedded --socket <path>` itself, never through
//! open(1), so the driver inherits the host's macOS grants; the mode and the
//! manifest go in through the environment; `cua-driver mcp --embedded
//! --socket <path>` is the stdio proxy a client talks to.

use std::path::{Path, PathBuf};

/// The helper's own bundle id. MonoCode's manifest never names it.
pub const HELPER_BUNDLE_ID: &str = "com.monocode.computer-use-helper";

/// One process to start: program, arguments, and the environment to set on
/// top of a cleared one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// The environment every driver process gets. The helper clears its own
/// environment before adding these, so nothing from the caller leaks in.
pub fn base_env(home: &Path) -> Vec<(String, String)> {
    vec![
        ("HOME".into(), home.to_string_lossy().into_owned()),
        ("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into()),
        // C6: Cua's own calls off for this process, whatever its saved config.
        ("CUA_DRIVER_RS_TELEMETRY_ENABLED".into(), "false".into()),
        ("CUA_DRIVER_RS_UPDATE_CHECK".into(), "false".into()),
        ("DO_NOT_TRACK".into(), "1".into()),
        ("CUA_TELEMETRY".into(), "0".into()),
        ("CUA_DRIVER_DISABLE_RUN_SCRIPT".into(), "1".into()),
    ]
}

/// The daemon for one runtime, bounded by the manifest at `manifest`.
pub fn serve_launch(driver: &Path, socket: &Path, manifest: &Path, home: &Path) -> Launch {
    let mut env = base_env(home);
    env.extend([
        ("CUA_DRIVER_EMBEDDED".into(), "1".into()),
        ("CUA_DRIVER_HOST_BUNDLE_ID".into(), HELPER_BUNDLE_ID.into()),
        ("CUA_DRIVER_PERMISSION_MODE".into(), "bounded".into()),
        (
            "CUA_DRIVER_CAPABILITY_MANIFEST_FILE".into(),
            manifest.to_string_lossy().into_owned(),
        ),
        ("CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED".into(), "1".into()),
    ]);
    Launch {
        program: driver.to_path_buf(),
        args: vec![
            "serve".into(),
            "--embedded".into(),
            "--socket".into(),
            socket.to_string_lossy().into_owned(),
            "--host-bundle-id".into(),
            HELPER_BUNDLE_ID.into(),
            "--permission-mode".into(),
            "bounded".into(),
            "--capability-manifest".into(),
            manifest.to_string_lossy().into_owned(),
            "--approve-capability-manifest".into(),
        ],
        env,
    }
}

/// The stdio proxy the helper talks MCP through.
pub fn mcp_launch(driver: &Path, socket: &Path, home: &Path) -> Launch {
    Launch {
        program: driver.to_path_buf(),
        args: vec![
            "mcp".into(),
            "--embedded".into(),
            "--socket".into(),
            socket.to_string_lossy().into_owned(),
        ],
        env: base_env(home),
    }
}

/// A runtime id MonoCode sent, if it is safe to put in a file name.
pub fn runtime_id(raw: &str) -> Option<&str> {
    let ok = !raw.is_empty()
        && raw.len() <= 64
        && raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then_some(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serve_is_bounded_by_the_manifest_with_cuas_calls_off() {
        let launch = serve_launch(
            Path::new("/H.app/Contents/MacOS/cua-driver"),
            Path::new("/d/rt1.sock"),
            Path::new("/d/rt1.yaml"),
            Path::new("/Users/t"),
        );
        assert_eq!(&launch.args[..2], ["serve", "--embedded"]);
        let env = |key: &str| {
            launch
                .env
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(env("CUA_DRIVER_PERMISSION_MODE"), Some("bounded"));
        assert_eq!(
            env("CUA_DRIVER_CAPABILITY_MANIFEST_FILE"),
            Some("/d/rt1.yaml")
        );
        assert_eq!(env("CUA_DRIVER_RS_TELEMETRY_ENABLED"), Some("false"));
        assert_eq!(env("CUA_DRIVER_RS_UPDATE_CHECK"), Some("false"));
        assert_eq!(env("CUA_DRIVER_DISABLE_RUN_SCRIPT"), Some("1"));
        assert!(env("CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS").is_none());
        assert!(!launch.args.iter().any(|a| a.contains("unrestricted")));
    }

    #[test]
    fn the_proxy_has_cuas_calls_off_too() {
        let launch = mcp_launch(
            Path::new("/d/cua-driver"),
            Path::new("/d/s"),
            Path::new("/h"),
        );
        assert_eq!(launch.args, ["mcp", "--embedded", "--socket", "/d/s"]);
        assert!(launch
            .env
            .contains(&("CUA_DRIVER_RS_UPDATE_CHECK".into(), "false".into())));
    }

    #[test]
    fn runtime_ids_are_file_safe() {
        assert_eq!(runtime_id("rt-1_a"), Some("rt-1_a"));
        for bad in ["", "../x", "a/b", "a b", &"x".repeat(65)] {
            assert_eq!(runtime_id(bad), None, "{bad}");
        }
    }
}
