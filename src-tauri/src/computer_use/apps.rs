//! Which apps a chat may be granted, and which carry a warning.
//!
//! An app is named by its bundle id. MonoCode itself and the helper that holds
//! the macOS grants are never granted: an agent that could drive MonoCode
//! could approve its own cards.

/// The longest bundle id taken. macOS has no documented limit; 255 matches a
/// file name and is far past any real one.
const MAX_BUNDLE_ID: usize = 255;

/// Bundle ids, or prefixes ending in `.`, that are never granted.
const NEVER: &[&str] = &[
    // MonoCode, its dev build and anything it ships, the helper included.
    "com.monocode.",
    "com.monocode.desktop",
    // Cua's own app. MonoCode embeds the driver in its helper instead, and
    // the standalone app's grants are what note W warns against.
    "com.trycua.",
    // The screen lock and login window: driving them is driving the session.
    "com.apple.loginwindow",
    "com.apple.ScreenSaver.Engine",
    "com.apple.SecurityAgent",
];

/// What the approval card warns about for an app (C5).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AppWarning {
    /// A terminal: typing into it runs commands as you, outside every sandbox.
    Terminal,
    /// Finder: it can move, rename and delete any file you can.
    Finder,
    /// System Settings: it can change privacy grants, the firewall and users.
    SystemSettings,
}

const TERMINALS: &[&str] = &[
    "com.apple.terminal",
    "com.googlecode.iterm2",
    "com.mitchellh.ghostty",
    "dev.warp.warp-stable",
    "net.kovidgoyal.kitty",
    "io.alacritty",
    "org.alacritty",
    "com.github.wez.wezterm",
    "co.zeit.hyper",
    "com.microsoft.vscode",
    "com.todesktop.230313mzl4w4u92",
];
const FINDERS: &[&str] = &["com.apple.finder"];
const SETTINGS: &[&str] = &[
    "com.apple.systempreferences",
    "com.apple.settings",
    "com.apple.systemsettings",
];

/// Why a bundle id was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppRefusal {
    Invalid,
    Never,
}

impl AppRefusal {
    pub fn message(&self) -> &'static str {
        match self {
            AppRefusal::Invalid => "That is not a bundle id, such as com.apple.calculator.",
            AppRefusal::Never => {
                "MonoCode never grants itself, its helper, Cua's own app or the login window."
            }
        }
    }
}

/// The bundle id as given, if it is a well-formed reverse-DNS id. Names are
/// taken literally: no trimming of inner characters, no case change.
pub fn parse_bundle_id(raw: &str) -> Result<String, AppRefusal> {
    let id = raw.trim_matches(|c: char| c == ' ' || c == '\t');
    if id.is_empty() || id.len() > MAX_BUNDLE_ID {
        return Err(AppRefusal::Invalid);
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return Err(AppRefusal::Invalid);
    }
    let parts: Vec<&str> = id.split('.').collect();
    if parts.len() < 2 || parts.iter().any(|part| part.is_empty()) {
        return Err(AppRefusal::Invalid);
    }
    if is_never(id) {
        return Err(AppRefusal::Never);
    }
    Ok(id.to_string())
}

/// True for MonoCode, its helper and the other ids in `NEVER`. Compared
/// without case, since Launch Services matches bundle ids without case.
pub fn is_never(id: &str) -> bool {
    let lower = id.to_ascii_lowercase();
    NEVER.iter().any(|never| {
        let never = never.to_ascii_lowercase();
        if never.ends_with('.') {
            lower.starts_with(&never) || lower == never.trim_end_matches('.')
        } else {
            lower == never
        }
    })
}

/// The warning the card shows for this app, if any.
pub fn warning_for(id: &str) -> Option<AppWarning> {
    let lower = id.to_ascii_lowercase();
    if TERMINALS.contains(&lower.as_str()) {
        Some(AppWarning::Terminal)
    } else if FINDERS.contains(&lower.as_str()) {
        Some(AppWarning::Finder)
    } else if SETTINGS.contains(&lower.as_str()) {
        Some(AppWarning::SystemSettings)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_an_ordinary_bundle_id_as_given() {
        assert_eq!(
            parse_bundle_id("com.apple.calculator").unwrap(),
            "com.apple.calculator"
        );
        assert_eq!(
            parse_bundle_id("  com.Apple.Calculator ").unwrap(),
            "com.Apple.Calculator"
        );
    }

    #[test]
    fn refuses_what_is_not_a_bundle_id() {
        for bad in [
            "",
            "calculator",
            "com..apple",
            ".com.apple",
            "com.apple.",
            "com.apple/calc",
            "com.apple calc",
            "com.apple.calc\u{a0}",
            "-rf.x\n",
            "../etc.passwd",
            &"a.".repeat(200),
        ] {
            assert_eq!(parse_bundle_id(bad), Err(AppRefusal::Invalid), "{bad:?}");
        }
    }

    #[test]
    fn never_grants_monocode_its_helper_or_cua() {
        for never in [
            "com.monocode.desktop",
            "COM.MONOCODE.DESKTOP",
            "com.monocode.computer-use-helper",
            "com.monocode",
            "com.trycua.driver",
            "com.apple.loginwindow",
        ] {
            assert_eq!(parse_bundle_id(never), Err(AppRefusal::Never), "{never}");
        }
        assert!(parse_bundle_id("com.monocodex.app").is_ok());
    }

    #[test]
    fn warns_for_terminals_finder_and_settings() {
        assert_eq!(warning_for("com.apple.Terminal"), Some(AppWarning::Terminal));
        assert_eq!(warning_for("com.googlecode.iterm2"), Some(AppWarning::Terminal));
        assert_eq!(warning_for("com.apple.finder"), Some(AppWarning::Finder));
        assert_eq!(
            warning_for("com.apple.systempreferences"),
            Some(AppWarning::SystemSettings)
        );
        assert_eq!(warning_for("com.apple.calculator"), None);
    }
}
