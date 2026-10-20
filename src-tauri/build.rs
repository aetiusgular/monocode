#[path = "src/app_identity.rs"]
mod app_identity;

fn main() {
    // generate_context! embeds icons; cargo ignores them unless we watch here.
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=macos/Assets.car");
    // GNU ld exports every symbol from the Tauri cdylib and blows past the
    // 65535 PE ordinal limit. Hide them; the desktop exe links the rlib.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu")
    {
        println!("cargo::rustc-link-arg-cdylib=-Wl,--exclude-libs=ALL,--exclude-all-symbols");
    }
    export_identity();
    tauri_build::build()
}

/// The identifier and name `tauri dev --config src-tauri/tauri.dev.conf.json`
/// gives the build, for code that runs before Tauri's builder (the macOS dev
/// `.app` wrapper). `tauri_build::build()` already watches `TAURI_CONFIG`.
fn export_identity() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    let base = std::fs::read_to_string("tauri.conf.json").expect("read tauri.conf.json");
    let base: serde_json::Value = serde_json::from_str(&base).expect("parse tauri.conf.json");
    let patch = std::env::var("TAURI_CONFIG").ok();
    let identity = app_identity::merged(&base, patch.as_deref())
        .unwrap_or_else(|error| panic!("app identity: {error}"));
    println!(
        "cargo:rustc-env=MONOCODE_APP_IDENTIFIER={}",
        identity.identifier
    );
    println!(
        "cargo:rustc-env=MONOCODE_PRODUCT_NAME={}",
        identity.product_name
    );
}
