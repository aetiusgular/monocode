//! What a harness is started with so it exports to the receiver: pure
//! functions, tested here and mirrored by `tests/cli-contract/checks/otel.mjs`
//! (keep the two in step).
//!
//! The token goes in the environment only, never in an argument: any process
//! on the Mac, of any user, can read another process's arguments with `ps`,
//! while its environment is readable only by the same user. Everything in
//! the arguments here is free to read: the port and the switches.

/// The header that carries a chat's token. A plain name with no space in the
/// value, so the `OTEL_EXPORTER_OTLP_HEADERS` form (`key=value`, percent
/// decoded by some SDKs) cannot mangle it.
pub const TOKEN_HEADER: &str = "x-monocode-token";

/// How often Claude Code flushes its log batch, in milliseconds. Short, so a
/// tool call reaches the feed while its adapter event still waits to join.
pub const CLAUDE_LOGS_EXPORT_INTERVAL_MS: u32 = 1000;

/// Which harness, from MonoCode's provider name and the spawn's arguments.
/// Only an interactive Claude Code chat and a Codex app-server qualify:
/// helper prompts, catalogue probes and sign-ins never get telemetry.
pub fn telemetry_harness(binary_provider: Option<&str>, args: &[String]) -> Option<&'static str> {
    match binary_provider? {
        "claude" => {
            let interactive = args.iter().any(|a| a == "--input-format")
                && !args
                    .iter()
                    .any(|a| a == "--no-session-persistence" || a == "-p" || a == "--print");
            interactive.then_some("claude")
        }
        "codex" => (args.first().map(String::as_str) == Some("app-server")).then_some("codex"),
        _ => None,
    }
}

/// Variables that mean the user already sends Claude Code's telemetry
/// somewhere. MonoCode then leaves it alone.
pub const CLAUDE_OWN_TELEMETRY_VARS: &[&str] = &[
    "CLAUDE_CODE_ENABLE_TELEMETRY",
    "OTEL_LOGS_EXPORTER",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
];

/// True when the inherited environment already configures an export.
pub fn has_own_env_telemetry(env: &dyn Fn(&str) -> Option<String>) -> bool {
    CLAUDE_OWN_TELEMETRY_VARS
        .iter()
        .any(|name| env(name).is_some_and(|v| !v.trim().is_empty()))
}

/// True when a Codex `config.toml` exports logs or traces somewhere itself.
/// `exporter = "none"` (the local home's setting) does not count.
pub fn has_own_codex_otel(config_toml: Option<&str>) -> bool {
    let Some(text) = config_toml else {
        return false;
    };
    let Ok(value) = toml::from_str::<toml::Table>(text) else {
        // An unreadable config: assume the user's, and keep out.
        return true;
    };
    let Some(otel) = value.get("otel").and_then(toml::Value::as_table) else {
        return false;
    };
    ["exporter", "trace_exporter"]
        .iter()
        .any(|key| match otel.get(*key) {
            None => false,
            Some(toml::Value::String(s)) => s != "none",
            Some(_) => true,
        })
}

/// Claude Code's environment for an export to `endpoint`
/// (`http://127.0.0.1:<port>`; Claude Code adds `/v1/logs`). Logs only:
/// every event the log uses is a log record. Tool details on; prompt text by
/// the switch. The returned `remove` list is unset in the child.
pub fn claude_env(
    endpoint: &str,
    token: &str,
    log_prompts: bool,
) -> (Vec<(String, String)>, Vec<String>) {
    let mut set = vec![
        ("CLAUDE_CODE_ENABLE_TELEMETRY", "1".to_string()),
        ("OTEL_LOGS_EXPORTER", "otlp".to_string()),
        ("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json".to_string()),
        ("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint.to_string()),
        (
            "OTEL_EXPORTER_OTLP_HEADERS",
            format!("{TOKEN_HEADER}={token}"),
        ),
        (
            "OTEL_LOGS_EXPORT_INTERVAL",
            CLAUDE_LOGS_EXPORT_INTERVAL_MS.to_string(),
        ),
        ("OTEL_LOG_TOOL_DETAILS", "1".to_string()),
    ];
    let mut remove = Vec::new();
    if log_prompts {
        set.push(("OTEL_LOG_USER_PROMPTS", "1".to_string()));
    } else {
        remove.push("OTEL_LOG_USER_PROMPTS".to_string());
    }
    (
        set.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
        remove,
    )
}

/// Codex's `-c` flags for an export to `endpoint`. Codex takes each signal's
/// full URL. Traces and metrics off: metrics would otherwise go to Codex's
/// default, Statsig, an outbound call MonoCode does not need.
pub fn codex_args(endpoint: &str, log_prompts: bool) -> Vec<String> {
    let logs = format!("{endpoint}/v1/logs");
    vec![
        "-c".into(),
        format!(
            "otel.exporter={{otlp-http={{endpoint={},protocol=\"json\"}}}}",
            toml_string(&logs)
        ),
        "-c".into(),
        "otel.trace_exporter=\"none\"".into(),
        "-c".into(),
        "otel.metrics_exporter=\"none\"".into(),
        "-c".into(),
        format!("otel.log_user_prompt={log_prompts}"),
    ]
}

/// Codex's environment: the token, read by the OTLP exporter beside the
/// headers in its config.
pub fn codex_env(token: &str) -> Vec<(String, String)> {
    let header = format!("{TOKEN_HEADER}={token}");
    vec![
        ("OTEL_EXPORTER_OTLP_HEADERS".to_string(), header.clone()),
        ("OTEL_EXPORTER_OTLP_LOGS_HEADERS".to_string(), header),
    ]
}

/// A TOML basic string. The endpoint is MonoCode's own loopback URL, but it
/// is quoted properly all the same.
fn toml_string(s: &str) -> String {
    toml::Value::String(s.to_string()).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn only_chats_get_telemetry() {
        let chat = s(&[
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
        ]);
        assert_eq!(telemetry_harness(Some("claude"), &chat), Some("claude"));
        let helper = s(&["--input-format", "stream-json", "--no-session-persistence"]);
        assert_eq!(telemetry_harness(Some("claude"), &helper), None);
        assert_eq!(telemetry_harness(Some("claude"), &s(&["-p", "hi"])), None);
        assert_eq!(
            telemetry_harness(Some("codex"), &s(&["app-server", "-c", "x=1"])),
            Some("codex")
        );
        assert_eq!(telemetry_harness(Some("codex"), &s(&["exec", "hi"])), None);
        assert_eq!(telemetry_harness(Some("cursor"), &s(&["acp"])), None);
        assert_eq!(telemetry_harness(None, &chat), None);
    }

    #[test]
    fn claude_env_carries_token_only_in_env() {
        let (set, remove) = claude_env("http://127.0.0.1:4318", "abc", false);
        let get = |k: &str| set.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("CLAUDE_CODE_ENABLE_TELEMETRY"), Some("1"));
        assert_eq!(
            get("OTEL_EXPORTER_OTLP_ENDPOINT"),
            Some("http://127.0.0.1:4318")
        );
        assert_eq!(
            get("OTEL_EXPORTER_OTLP_HEADERS"),
            Some("x-monocode-token=abc")
        );
        assert_eq!(get("OTEL_LOG_TOOL_DETAILS"), Some("1"));
        assert_eq!(get("OTEL_LOG_USER_PROMPTS"), None);
        assert_eq!(remove, vec!["OTEL_LOG_USER_PROMPTS".to_string()]);
        let (set, remove) = claude_env("http://127.0.0.1:1", "t", true);
        assert!(set
            .iter()
            .any(|(k, v)| k == "OTEL_LOG_USER_PROMPTS" && v == "1"));
        assert!(remove.is_empty());
    }

    #[test]
    fn codex_args_hold_no_token() {
        let args = codex_args("http://127.0.0.1:4318", false);
        assert_eq!(
            args,
            s(&[
                "-c",
                "otel.exporter={otlp-http={endpoint=\"http://127.0.0.1:4318/v1/logs\",protocol=\"json\"}}",
                "-c",
                "otel.trace_exporter=\"none\"",
                "-c",
                "otel.metrics_exporter=\"none\"",
                "-c",
                "otel.log_user_prompt=false",
            ])
        );
        // Each value parses as TOML, as Codex reads it.
        for flag in args.iter().skip(1).step_by(2) {
            let (key, value) = flag.split_once('=').unwrap();
            let parsed: toml::Table =
                toml::from_str(&format!("v = {value}")).unwrap_or_else(|e| panic!("{key}: {e}"));
            assert!(parsed.contains_key("v"));
        }
        assert!(codex_args("http://127.0.0.1:1", true)
            .contains(&"otel.log_user_prompt=true".to_string()));
        let env = codex_env("tok");
        assert!(env.iter().all(|(_, v)| v == "x-monocode-token=tok"));
    }

    #[test]
    fn users_own_export_is_left_alone() {
        let none = |_: &str| None;
        assert!(!has_own_env_telemetry(&none));
        let set =
            |k: &str| (k == "OTEL_EXPORTER_OTLP_ENDPOINT").then(|| "https://collector".to_string());
        assert!(has_own_env_telemetry(&set));
        let empty = |k: &str| (k == "CLAUDE_CODE_ENABLE_TELEMETRY").then(|| " ".to_string());
        assert!(!has_own_env_telemetry(&empty));

        assert!(!has_own_codex_otel(None));
        assert!(!has_own_codex_otel(Some("model = \"x\"\n")));
        assert!(!has_own_codex_otel(Some(
            "[otel]\nexporter = \"none\"\nmetrics_exporter = \"none\"\n"
        )));
        assert!(has_own_codex_otel(Some("[otel]\nexporter = { otlp-http = { endpoint = \"https://x/v1/logs\", protocol = \"binary\" } }\n")));
        assert!(has_own_codex_otel(Some(
            "[otel]\ntrace_exporter = \"statsig\"\n"
        )));
        assert!(has_own_codex_otel(Some("this is [not toml")));
    }
}
