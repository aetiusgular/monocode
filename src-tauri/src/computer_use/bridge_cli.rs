//! `MonoCode computer-use-mcp`: the stdio MCP server a harness starts for a
//! chat with computer use on. It holds no state: it connects to the app's
//! loopback endpoint with the chat's token and relays lines both ways.
//!
//! The endpoint and token come only from the environment MonoCode set on the
//! harness process (`MONOCODE_CU_ENDPOINT`, `MONOCODE_CU_TOKEN`), never from
//! arguments, so no command line or MCP config file names them.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::thread;
use std::time::Duration;

pub const ENDPOINT_ENV: &str = "MONOCODE_CU_ENDPOINT";
pub const TOKEN_ENV: &str = "MONOCODE_CU_TOKEN";
/// The longest line relayed toward the harness: a screenshot result.
const MAX_LINE: usize = 64 * 1024 * 1024;

/// Where to connect, from the two values. Loopback only.
pub fn endpoint(raw: Option<&str>) -> Result<SocketAddr, String> {
    let raw = raw.ok_or(
        "Computer use is not on for this chat. Switch it on in MonoCode, then start a new turn.",
    )?;
    let address: SocketAddr = raw
        .parse()
        .map_err(|_| "Bad MonoCode endpoint".to_string())?;
    if !address.ip().is_loopback() {
        return Err("The MonoCode endpoint must be on this machine.".into());
    }
    Ok(address)
}

pub fn run() -> i32 {
    match relay() {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("monocode computer-use: {message}");
            1
        }
    }
}

fn relay() -> Result<(), String> {
    let address = endpoint(std::env::var(ENDPOINT_ENV).ok().as_deref())?;
    let token =
        std::env::var(TOKEN_ENV).map_err(|_| "No computer-use token for this chat.".to_string())?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3))
        .map_err(|e| format!("Cannot reach MonoCode at {address}: {e}"))?;
    let _ = stream.set_nodelay(true);
    let mut hello = serde_json::json!({"token": token}).to_string();
    hello.push('\n');
    stream
        .write_all(hello.as_bytes())
        .map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut first = String::new();
    reader
        .by_ref()
        .take(4096)
        .read_line(&mut first)
        .map_err(|e| format!("No answer from MonoCode: {e}"))?;
    let answer: serde_json::Value =
        serde_json::from_str(&first).map_err(|_| "Bad answer from MonoCode".to_string())?;
    if answer.get("monocode").and_then(|v| v.as_str()) != Some("ok") {
        let message = answer
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("MonoCode refused.");
        return Err(message.chars().take(200).collect());
    }
    stream.set_read_timeout(None).map_err(|e| e.to_string())?;

    // Harness to MonoCode.
    let mut upstream = stream.try_clone().map_err(|e| e.to_string())?;
    thread::spawn(move || {
        let _ = io::copy(&mut io::stdin().lock(), &mut upstream);
        let _ = upstream.shutdown(std::net::Shutdown::Write);
    });
    // MonoCode to the harness, a line at a time.
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader
            .by_ref()
            .take(MAX_LINE as u64 + 1)
            .read_until(b'\n', &mut line)
            .map_err(|e| e.to_string())?;
        if read == 0 {
            return Ok(());
        }
        if line.len() > MAX_LINE {
            return Err("A reply from MonoCode was too large.".into());
        }
        out.write_all(&line)
            .and_then(|_| out.flush())
            .map_err(|e| e.to_string())?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_only_a_loopback_endpoint() {
        assert!(endpoint(Some("127.0.0.1:4000")).is_ok());
        assert!(endpoint(Some("[::1]:4000")).is_ok());
        assert!(endpoint(None).unwrap_err().contains("not on for this chat"));
        assert!(endpoint(Some("10.0.0.2:4000")).is_err());
        assert!(endpoint(Some("localhost:4000")).is_err(), "no name lookup");
        assert!(endpoint(Some("")).is_err());
    }
}
