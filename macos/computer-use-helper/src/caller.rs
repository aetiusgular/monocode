//! Who may talk to the helper: MonoCode only, checked by code signature
//! (note W, section 4). Agents can start the helper with open(1) and connect
//! to its socket; the check is what refuses them.

/// The code requirement MonoCode's signature must meet, set at build time
/// from the identity both apps are signed with (`MONOCODE_HELPER_IDENTITY`,
/// plan section 3, call 4). Absent in a build without one.
pub fn built_requirement() -> Option<&'static str> {
    option_env!("MONOCODE_HELPER_CALLER_REQUIREMENT").filter(|text| !text.trim().is_empty())
}

/// The requirement for MonoCode signed with one certificate, pinned by its
/// SHA-1 (`security find-certificate -c <identity> -Z`). A name is not enough:
/// any process of the user can make a self-signed certificate with the same
/// common name (security review, finding 1). Anything but 40 hex digits is
/// refused.
pub fn requirement_for(sha1: &str) -> Option<String> {
    let sha1 = sha1.trim();
    if sha1.len() != 40 || !sha1.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!(
        "identifier \"com.monocode.desktop\" and certificate leaf = H\"{}\"",
        sha1.to_ascii_uppercase()
    ))
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    Refuse(&'static str),
}

/// The decision, from what the platform could tell about the peer.
///
/// - `signed`: whether the peer's code met the built requirement; None when
///   no requirement was built in or the platform could not check.
/// - `peer_pid` and `parent_pid`: the peer's pid, and the MonoCode pid the
///   helper was started for.
/// - `debug`: a debug build of the helper.
///
/// A release build with no requirement refuses everyone. A debug build with
/// no requirement takes only the pid it was started for, and says so in its
/// log: an agent that starts the helper itself can name its own pid.
pub fn decide(
    signed: Option<bool>,
    peer_pid: Option<i32>,
    parent_pid: i32,
    debug: bool,
) -> Verdict {
    match signed {
        Some(true) if peer_pid == Some(parent_pid) => Verdict::Allow,
        Some(true) => {
            Verdict::Refuse("caller is signed but is not the MonoCode that started the helper")
        }
        Some(false) => Verdict::Refuse("caller's code signature does not match MonoCode's"),
        None if debug && peer_pid == Some(parent_pid) => Verdict::Allow,
        None if debug => Verdict::Refuse("caller is not the MonoCode that started the helper"),
        None => Verdict::Refuse("this build has no signing requirement, so it takes no caller"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_signed_monocode_with_the_right_pid_is_let_in() {
        assert_eq!(decide(Some(true), Some(10), 10, false), Verdict::Allow);
    }

    #[test]
    fn everything_else_is_refused_in_a_release_build() {
        assert!(matches!(
            decide(Some(false), Some(10), 10, false),
            Verdict::Refuse(_)
        ));
        assert!(matches!(
            decide(Some(true), Some(11), 10, false),
            Verdict::Refuse(_)
        ));
        assert!(matches!(
            decide(None, Some(10), 10, false),
            Verdict::Refuse(_)
        ));
        assert!(matches!(
            decide(Some(true), None, 10, false),
            Verdict::Refuse(_)
        ));
    }

    #[test]
    fn a_debug_build_without_a_requirement_takes_only_its_parent() {
        assert_eq!(decide(None, Some(10), 10, true), Verdict::Allow);
        assert!(matches!(
            decide(None, Some(11), 10, true),
            Verdict::Refuse(_)
        ));
        assert!(matches!(decide(None, None, 10, true), Verdict::Refuse(_)));
        // A failed signature check is never waved through, debug or not.
        assert!(matches!(
            decide(Some(false), Some(10), 10, true),
            Verdict::Refuse(_)
        ));
    }

    #[test]
    fn requirement_text() {
        assert_eq!(
            requirement_for("0123456789abcdef0123456789abcdef01234567").unwrap(),
            "identifier \"com.monocode.desktop\" and certificate leaf = H\"0123456789ABCDEF0123456789ABCDEF01234567\""
        );
        // A name, a quote trick, a short hash: all refused.
        assert!(requirement_for("MonoCode Dev").is_none());
        assert!(requirement_for("x\" or true or \"").is_none());
        assert!(requirement_for("0123456789abcdef0123456789abcdef0123456").is_none());
        assert!(requirement_for(" ").is_none());
    }
}
