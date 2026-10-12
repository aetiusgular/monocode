//! Runs the edit adapter outside the app, for the contract check in
//! `tests/cli-contract/checks/editAdapter.mjs`.
//!
//!   cargo run --example edit_adapter_proxy -- --upstream http://127.0.0.1:11434/v1 --root /path/to/project
//!
//! Prints the route's base URL on one line, then serves until stdin closes.

use std::io::Read;

// The module is compiled in directly, not linked from the app library, so the
// binary stays small: `cargo test` builds every example, and the Mac's disk
// is tight (rules, corner case 19).
#[allow(dead_code)]
#[path = "../src/edit_adapter.rs"]
mod edit_adapter;

fn main() {
    let mut upstream = None;
    let mut root = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--upstream" => upstream = args.next(),
            "--root" => root = args.next(),
            other => {
                eprintln!("unknown argument {other}");
                std::process::exit(2);
            }
        }
    }
    let (Some(upstream), Some(root)) = (upstream, root) else {
        eprintln!("usage: edit_adapter_proxy --upstream <url> --root <folder>");
        std::process::exit(2);
    };
    match edit_adapter::open_route("contract-check", &upstream, &root) {
        Ok(base) => println!("{base}"),
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    }
    let mut sink = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut sink);
}
