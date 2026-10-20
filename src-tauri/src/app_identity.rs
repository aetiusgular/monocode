//! The app's identifier and product name, merged the way Tauri merges them at
//! build time: `tauri.conf.json`, then the `TAURI_CONFIG` value the CLI sets
//! from every `--config` (JSON Merge Patch; tauri-build 2.6.3
//! `src/lib.rs:487-490`, tauri-codegen 2.6.3 `src/lib.rs:83-87`).
//!
//! `build.rs` uses this to export `MONOCODE_APP_IDENTIFIER` and
//! `MONOCODE_PRODUCT_NAME`, because MonoCode's macOS dev `.app` wrapper runs
//! before Tauri's builder and so cannot read `app.config()`. Platform files
//! (`tauri.linux.conf.json`, `tauri.windows.conf.json`) set neither key.

use serde_json::Value;

pub struct Identity {
    pub identifier: String,
    pub product_name: String,
}

/// `base` is `tauri.conf.json`; `patch` is `TAURI_CONFIG`, when set.
pub fn merged(base: &Value, patch: Option<&str>) -> Result<Identity, String> {
    let mut identifier =
        string_at(base, "identifier").ok_or("tauri.conf.json has no identifier")?;
    let mut product_name = string_at(base, "productName").unwrap_or_else(|| identifier.clone());
    if let Some(patch) = patch.map(str::trim).filter(|p| !p.is_empty()) {
        let patch: Value =
            serde_json::from_str(patch).map_err(|e| format!("TAURI_CONFIG is not JSON: {e}"))?;
        if let Some(value) = string_at(&patch, "identifier") {
            identifier = value;
        }
        if let Some(value) = string_at(&patch, "productName") {
            product_name = value;
        }
    }
    if !valid_identifier(&identifier) {
        return Err(format!("not a bundle identifier: {identifier:?}"));
    }
    if product_name.is_empty() || product_name.chars().any(char::is_control) {
        return Err("bad productName".into());
    }
    Ok(Identity {
        identifier,
        product_name,
    })
}

fn string_at(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Letters, digits, `-` and `.`, as a bundle identifier allows.
fn valid_identifier(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 155
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base() -> Value {
        json!({"identifier": "com.monocode.desktop", "productName": "MonoCode"})
    }

    #[test]
    fn without_a_patch_it_is_the_release_identity() {
        let id = merged(&base(), None).unwrap();
        assert_eq!(id.identifier, "com.monocode.desktop");
        assert_eq!(id.product_name, "MonoCode");
    }

    #[test]
    fn the_dev_config_gives_the_dev_identity() {
        let dev = include_str!("../tauri.dev.conf.json");
        let id = merged(&base(), Some(dev)).unwrap();
        assert_eq!(id.identifier, "com.monocode.desktop.dev");
        assert_eq!(id.product_name, "MonoCode Dev");
    }

    #[test]
    fn the_cli_merge_of_dev_and_stable_keeps_the_dev_identity() {
        // The value the CLI 2.11.4 passed for `tauri:stable`, seen 20 Oct 2026.
        let patch = r#"{"identifier":"com.monocode.desktop.dev","productName":"MonoCode Dev","build":{"beforeDevCommand":"npm run dev:stable"}}"#;
        assert_eq!(
            merged(&base(), Some(patch)).unwrap().identifier,
            "com.monocode.desktop.dev"
        );
    }

    #[test]
    fn the_real_config_is_the_release_identity() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            merged(&conf, None).unwrap().identifier,
            "com.monocode.desktop"
        );
    }

    #[test]
    fn refuses_what_a_plist_or_codesign_could_misread() {
        for bad in [
            r#"{"identifier":"com.x\"/>"}"#,
            r#"{"identifier":"a b"}"#,
            r#"{"identifier":""}"#,
            "not json",
        ] {
            assert!(merged(&base(), Some(bad)).is_err(), "{bad}");
        }
        assert!(merged(&base(), Some(r#"{"productName":"a\nb"}"#)).is_err());
    }

    #[test]
    fn the_build_constant_is_the_merge_of_this_build() {
        // `build.rs` and this test see the same `TAURI_CONFIG`, so the
        // constant the dev bundle uses equals Tauri's own merge.
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let id = merged(&conf, option_env!("TAURI_CONFIG")).unwrap();
        assert_eq!(crate::APP_IDENTIFIER, id.identifier);
        assert_eq!(crate::PRODUCT_NAME, id.product_name);
    }
}
