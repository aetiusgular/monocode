//! Voice input for the composer: the webview records 16 kHz mono 16-bit WAV,
//! and `whisper-cli` (whisper.cpp) turns it into text on this machine.
//!
//! The audio never leaves the Mac. The only network call here is the model
//! download the user starts from Settings, Voice, and its file is checked
//! against a pinned SHA-256 before it is used.
//!
//! The binary is never taken from the frontend: only the Homebrew paths and
//! then the user's PATH are searched. The arguments are fixed apart from the
//! model path (always the app data file) and a temp file this module creates.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::harness::{exec_output_with_stdin, gui_search_path};

const MODEL_FILE: &str = "ggml-base.en.bin";
const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
/// The Git LFS object of `ggml-base.en.bin` in huggingface.co/ggerganov/whisper.cpp
/// (file page "SHA256", and `lfs.oid` in `/api/models/ggerganov/whisper.cpp/tree/main`).
const MODEL_SHA256: &str = "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002";
const MODEL_BYTES: u64 = 147_964_211;
const PROGRESS_EVENT: &str = "monocode:voice-model-progress";
const WHISPER_BIN: &str = "whisper-cli";
const WHISPER_MISSING: &str = "whisper-cli not found. Install it with: brew install whisper-cpp";
const MODEL_MISSING: &str = "Voice model not downloaded. Open Settings, Voice.";
/// 5 minutes of 16 kHz mono 16-bit audio is 9,600,000 bytes plus a header.
const MAX_WAV_BYTES: usize = 10 * 1024 * 1024;
const WAV_HEADER_BYTES: usize = 44;
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_TEXT_CHARS: usize = 64 * 1024;
const MAX_ERROR_CHARS: usize = 2000;
const DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(60);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

static DOWNLOADING: AtomicBool = AtomicBool::new(false);
static CANCEL_DOWNLOAD: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    /// The `whisper-cli` that would run, or None when it is not installed.
    whisper_cli: Option<String>,
    model_path: String,
    /// Size of the model file, or None when it does not exist.
    model_bytes: Option<u64>,
    expected_model_bytes: u64,
    model_url: &'static str,
    model_sha256: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    received: u64,
    total: u64,
}

/// Whether `whisper-cli` and the model are in place.
#[tauri::command]
pub fn voice_status(app: AppHandle) -> Result<VoiceStatus, String> {
    let model = model_path(&app)?;
    Ok(VoiceStatus {
        whisper_cli: resolve_whisper().map(|path| path.to_string_lossy().into_owned()),
        model_bytes: std::fs::metadata(&model)
            .ok()
            .filter(|meta| meta.is_file())
            .map(|meta| meta.len()),
        model_path: model.to_string_lossy().into_owned(),
        expected_model_bytes: MODEL_BYTES,
        model_url: MODEL_URL,
        model_sha256: MODEL_SHA256,
    })
}

/// Transcribe one recording. `wav_base64` is a 16 kHz mono 16-bit PCM WAV.
#[tauri::command]
pub async fn voice_transcribe(app: AppHandle, wav_base64: String) -> Result<String, String> {
    let wav = decode_wav(&wav_base64)?;
    let model = model_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || transcribe(&wav, &model))
        .await
        .map_err(|e| e.to_string())?
}

/// Download the model to `<app data>/voice/`, checking its SHA-256 before it
/// replaces anything. Progress arrives as `monocode:voice-model-progress`.
#[tauri::command]
pub async fn voice_download_model(app: AppHandle) -> Result<(), String> {
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        return Err("The voice model is already downloading.".into());
    }
    CANCEL_DOWNLOAD.store(false, Ordering::SeqCst);
    let result = match model_path(&app) {
        Ok(model) => {
            let emitter = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                download(&model, |progress| {
                    let _ = emitter.emit(PROGRESS_EVENT, progress);
                })
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|inner| inner)
        }
        Err(err) => Err(err),
    };
    DOWNLOADING.store(false, Ordering::SeqCst);
    result
}

/// Stop a running model download. Its partial file is removed.
#[tauri::command]
pub fn voice_cancel_download() {
    CANCEL_DOWNLOAD.store(true, Ordering::SeqCst);
}

fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("voice");
    Ok(dir.join(MODEL_FILE))
}

/// Homebrew on Apple silicon, Homebrew on Intel, then the user's PATH.
fn resolve_whisper() -> Option<PathBuf> {
    resolve_whisper_in(
        &[
            "/opt/homebrew/bin/whisper-cli",
            "/usr/local/bin/whisper-cli",
        ],
        &gui_search_path(),
    )
}

fn resolve_whisper_in(fixed: &[&str], search_path: &str) -> Option<PathBuf> {
    fixed
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .or_else(|| {
            std::env::split_paths(search_path)
                .filter(|dir| dir.is_absolute())
                .map(|dir| dir.join(WHISPER_BIN))
                .find(|path| path.is_file())
        })
}

fn decode_wav(wav_base64: &str) -> Result<Vec<u8>, String> {
    // Base64 is 4 characters per 3 bytes. Refuse before decoding.
    if wav_base64.len() > MAX_WAV_BYTES.div_ceil(3) * 4 {
        return Err("Recording is too long.".into());
    }
    let wav = base64::engine::general_purpose::STANDARD
        .decode(wav_base64)
        .map_err(|_| "Recording is not valid audio.".to_string())?;
    check_wav(&wav)?;
    Ok(wav)
}

/// RIFF/WAVE, PCM, 1 channel, 16 kHz, 16 bits: what the webview encodes and
/// what whisper.cpp reads without converting.
fn check_wav(wav: &[u8]) -> Result<(), String> {
    let le16 = |at: usize| u16::from_le_bytes([wav[at], wav[at + 1]]);
    let le32 = |at: usize| u32::from_le_bytes([wav[at], wav[at + 1], wav[at + 2], wav[at + 3]]);
    let valid = wav.len() > WAV_HEADER_BYTES
        && wav.len() <= MAX_WAV_BYTES
        && &wav[0..4] == b"RIFF"
        && &wav[8..12] == b"WAVE"
        && &wav[12..16] == b"fmt "
        && le16(20) == 1
        && le16(22) == 1
        && le32(24) == 16_000
        && le16(34) == 16
        && &wav[36..40] == b"data";
    if valid {
        Ok(())
    } else {
        Err("Recording is not 16 kHz mono 16-bit WAV.".into())
    }
}

fn transcribe(wav: &[u8], model: &Path) -> Result<String, String> {
    let whisper = resolve_whisper().ok_or_else(|| WHISPER_MISSING.to_string())?;
    if !model.is_file() {
        return Err(MODEL_MISSING.into());
    }
    let command = whisper.to_string_lossy().into_owned();
    transcribe_with(wav, model, &std::env::temp_dir(), |args| {
        exec_output_with_stdin(&command, args, None, TRANSCRIBE_TIMEOUT, None)
    })
}

/// Writes the temp WAV, runs whisper-cli on it, and removes it again on every
/// path out, including a failed or timed out run.
fn transcribe_with(
    wav: &[u8],
    model: &Path,
    temp_dir: &Path,
    run: impl FnOnce(&[String]) -> Result<Output, String>,
) -> Result<String, String> {
    let temp = TempWav::create(temp_dir, wav)?;
    let args = whisper_args(model, temp.path())?;
    let output = run(&args)?;
    drop(temp);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.trim();
        return Err(if message.is_empty() {
            "whisper-cli failed".into()
        } else {
            message.chars().take(MAX_ERROR_CHARS).collect()
        });
    }
    Ok(clean_transcript(&String::from_utf8_lossy(&output.stdout)))
}

/// `-nt` drops the `[00:00:00.000 --> ...]` prefixes, `-np` silences every
/// log line, and progress printing is off unless `-pp` is passed. The text
/// then goes to stdout and nothing else does.
fn whisper_args(model: &Path, wav: &Path) -> Result<Vec<String>, String> {
    let utf8 = |path: &Path| {
        path.to_str()
            .map(str::to_string)
            .ok_or_else(|| "Path is not valid UTF-8.".to_string())
    };
    Ok(vec![
        "-m".into(),
        utf8(model)?,
        "-f".into(),
        utf8(wav)?,
        "-l".into(),
        "en".into(),
        "-nt".into(),
        "-np".into(),
    ])
}

/// One line of plain text. whisper.cpp marks silence as `[BLANK_AUDIO]`.
fn clean_transcript(stdout: &str) -> String {
    let text = stdout
        .replace("[BLANK_AUDIO]", " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    text.chars().take(MAX_TEXT_CHARS).collect()
}

/// A recording on disk for the length of one whisper-cli run. Readable only
/// by this user, and removed on drop, whether the run worked or not.
struct TempWav {
    path: PathBuf,
}

impl TempWav {
    fn create(dir: &Path, bytes: &[u8]) -> Result<Self, String> {
        let path = dir.join(format!("monocode-voice-{}.wav", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).map_err(|e| e.to_string())?;
        // From here on, drop removes the file even if the write fails.
        let temp = Self { path };
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(temp)
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempWav {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn download(model: &Path, progress: impl Fn(DownloadProgress)) -> Result<(), String> {
    let dir = model.parent().ok_or("missing model folder")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(DOWNLOAD_CONNECT_TIMEOUT)
        .timeout_read(DOWNLOAD_READ_TIMEOUT)
        .build();
    let response = agent
        .get(MODEL_URL)
        .call()
        .map_err(|e| format!("Download failed: {e}"))?;
    let part = PartFile::new(model.with_extension("bin.part"));
    let mut file = std::fs::File::create(part.path()).map_err(|e| e.to_string())?;
    let mut reader = response.into_reader().take(MODEL_BYTES + 1);
    let hash = copy_hashed(&mut reader, &mut file, &progress)?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    let written = std::fs::metadata(part.path())
        .map_err(|e| e.to_string())?
        .len();
    verify(written, &hash)?;
    std::fs::rename(part.path(), model).map_err(|e| e.to_string())?;
    part.keep();
    Ok(())
}

fn copy_hashed(
    reader: &mut impl Read,
    writer: &mut impl Write,
    progress: &impl Fn(DownloadProgress),
) -> Result<String, String> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    let mut received = 0u64;
    let mut reported = Instant::now() - PROGRESS_INTERVAL;
    loop {
        if CANCEL_DOWNLOAD.load(Ordering::SeqCst) {
            return Err("Download canceled.".into());
        }
        let read = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        writer
            .write_all(&buffer[..read])
            .map_err(|e| e.to_string())?;
        received += read as u64;
        if received > MODEL_BYTES {
            return Err("Download is larger than the expected model.".into());
        }
        if reported.elapsed() >= PROGRESS_INTERVAL {
            reported = Instant::now();
            progress(DownloadProgress {
                received,
                total: MODEL_BYTES,
            });
        }
    }
    progress(DownloadProgress {
        received,
        total: MODEL_BYTES,
    });
    Ok(hex(&hasher.finalize()))
}

fn verify(size: u64, sha256: &str) -> Result<(), String> {
    if size != MODEL_BYTES {
        return Err(format!(
            "Download stopped early ({size} of {MODEL_BYTES} bytes)."
        ));
    }
    if sha256 != MODEL_SHA256 {
        return Err("Downloaded model does not match its published SHA-256.".into());
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The download's temp file. Removed on drop unless it was renamed into place.
struct PartFile {
    path: PathBuf,
    keep: bool,
}

impl PartFile {
    fn new(path: PathBuf) -> Self {
        Self { path, keep: false }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn keep(mut self) {
        self.keep = true;
    }
}

impl Drop for PartFile {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// CANCEL_DOWNLOAD is global; tests that read it run one at a time.
    static CANCEL_LOCK: Mutex<()> = Mutex::new(());

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "monocode-voice-tests-{}-{name}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn wav(samples: usize) -> Vec<u8> {
        let data = (samples * 2) as u32;
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&16_000u32.to_le_bytes());
        out.extend_from_slice(&32_000u32.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data.to_le_bytes());
        out.resize(out.len() + samples * 2, 0);
        out
    }

    #[test]
    fn builds_fixed_plain_text_english_arguments() {
        let args = whisper_args(
            Path::new("/data/voice/ggml-base.en.bin"),
            Path::new("/tmp/monocode-voice-1.wav"),
        )
        .unwrap();
        assert_eq!(
            args,
            [
                "-m",
                "/data/voice/ggml-base.en.bin",
                "-f",
                "/tmp/monocode-voice-1.wav",
                "-l",
                "en",
                "-nt",
                "-np"
            ]
        );
        assert!(!args
            .iter()
            .any(|arg| arg == "-pp" || arg == "--print-progress"));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_paths_that_are_not_utf8() {
        use std::os::unix::ffi::OsStrExt;
        let bad = Path::new(std::ffi::OsStr::from_bytes(b"/tmp/\xff.wav"));
        assert!(whisper_args(Path::new("/m.bin"), bad).is_err());
    }

    #[test]
    fn accepts_only_16k_mono_16_bit_pcm() {
        assert!(check_wav(&wav(16)).is_ok());
        let mut stereo = wav(16);
        stereo[22] = 2;
        assert!(check_wav(&stereo).is_err());
        let mut rate = wav(16);
        rate[24..28].copy_from_slice(&44_100u32.to_le_bytes());
        assert!(check_wav(&rate).is_err());
        let mut float = wav(16);
        float[20] = 3;
        assert!(check_wav(&float).is_err());
        assert!(check_wav(b"RIFF").is_err());
        assert!(check_wav(&wav(0)).is_err());
        assert!(check_wav(&wav(MAX_WAV_BYTES / 2)).is_err());
    }

    #[test]
    fn decodes_base64_and_refuses_oversized_input_before_decoding() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(wav(160));
        assert_eq!(decode_wav(&encoded).unwrap().len(), 44 + 320);
        assert!(decode_wav("not base64!").is_err());
        let huge = "A".repeat(MAX_WAV_BYTES.div_ceil(3) * 4 + 4);
        assert_eq!(decode_wav(&huge).unwrap_err(), "Recording is too long.");
    }

    #[test]
    fn finds_homebrew_first_then_path() {
        let dir = scratch("resolve");
        let fixed = dir.join("brew").join(WHISPER_BIN);
        let on_path = dir.join("bin").join(WHISPER_BIN);
        std::fs::create_dir_all(fixed.parent().unwrap()).unwrap();
        std::fs::create_dir_all(on_path.parent().unwrap()).unwrap();
        std::fs::write(&on_path, b"").unwrap();
        let search = std::env::join_paths([
            PathBuf::from("relative/bin"),
            on_path.parent().unwrap().to_path_buf(),
        ])
        .unwrap();
        let search = search.to_str().unwrap();
        let fixed_str = fixed.to_str().unwrap();
        assert_eq!(
            resolve_whisper_in(&[fixed_str], search),
            Some(on_path.clone())
        );
        std::fs::write(&fixed, b"").unwrap();
        assert_eq!(resolve_whisper_in(&[fixed_str], search), Some(fixed));
        assert_eq!(resolve_whisper_in(&[], "relative/bin"), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn temp_wav_is_private_and_removed_on_drop() {
        let dir = scratch("temp");
        let temp = TempWav::create(&dir, b"audio").unwrap();
        let path = temp.path().to_path_buf();
        assert_eq!(std::fs::read(&path).unwrap(), b"audio");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        drop(temp);
        assert!(!path.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn exit(code: i32, stdout: &str, stderr: &str) -> Output {
        #[cfg(unix)]
        use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)]
        use std::os::windows::process::ExitStatusExt;
        #[cfg(unix)]
        let status = std::process::ExitStatus::from_raw(code << 8);
        #[cfg(windows)]
        let status = std::process::ExitStatus::from_raw(code as u32);
        Output {
            status,
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    fn assert_empty(dir: &Path) {
        assert_eq!(std::fs::read_dir(dir).unwrap().count(), 0);
    }

    #[test]
    fn runs_on_a_temp_copy_and_removes_it_after_success() {
        let dir = scratch("ok");
        let text = transcribe_with(&wav(16), Path::new("/m.bin"), &dir, |args| {
            let wav_path = Path::new(&args[3]);
            assert!(wav_path.starts_with(&dir));
            assert_eq!(std::fs::read(wav_path).unwrap().len(), 44 + 32);
            Ok(exit(0, " Hello.\n", ""))
        })
        .unwrap();
        assert_eq!(text, "Hello.");
        assert_empty(&dir);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn removes_the_temp_file_when_whisper_fails_or_times_out() {
        let dir = scratch("fail");
        let failed = transcribe_with(&wav(16), Path::new("/m.bin"), &dir, |_| {
            Ok(exit(1, "", "error: failed to read audio"))
        });
        assert_eq!(failed.unwrap_err(), "error: failed to read audio");
        assert_empty(&dir);
        let timed_out = transcribe_with(&wav(16), Path::new("/m.bin"), &dir, |_| {
            Err("Timed out".into())
        });
        assert_eq!(timed_out.unwrap_err(), "Timed out");
        assert_empty(&dir);
        let silent = transcribe_with(&wav(16), Path::new("/m.bin"), &dir, |_| Ok(exit(2, "", "")));
        assert_eq!(silent.unwrap_err(), "whisper-cli failed");
        assert_empty(&dir);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn temp_wav_refuses_to_reuse_an_existing_name() {
        let dir = scratch("exists");
        let first = TempWav::create(&dir, b"a").unwrap();
        // A fresh uuid every time, and create_new never follows an existing file.
        let second = TempWav::create(&dir, b"b").unwrap();
        assert_ne!(first.path(), second.path());
        drop((first, second));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn cleans_whisper_output_to_one_line() {
        assert_eq!(
            clean_transcript(" Hello there.\n And again. [BLANK_AUDIO]\n"),
            "Hello there. And again."
        );
        assert_eq!(clean_transcript("[BLANK_AUDIO]\n"), "");
        assert_eq!(
            clean_transcript(&"a".repeat(MAX_TEXT_CHARS + 10)).len(),
            MAX_TEXT_CHARS
        );
    }

    #[test]
    fn hashes_while_copying_and_reports_progress() {
        let _guard = CANCEL_LOCK.lock().unwrap();
        CANCEL_DOWNLOAD.store(false, Ordering::SeqCst);
        let calls = std::cell::RefCell::new(Vec::new());
        let mut out = Vec::new();
        let hash = copy_hashed(&mut &b"abc"[..], &mut out, &|p: DownloadProgress| {
            calls.borrow_mut().push(p.received)
        })
        .unwrap();
        assert_eq!(out, b"abc");
        // SHA-256("abc"), FIPS 180-2 test vector.
        assert_eq!(
            hash,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(calls.borrow().last(), Some(&3));
    }

    #[test]
    fn stops_copying_when_canceled() {
        let _guard = CANCEL_LOCK.lock().unwrap();
        CANCEL_DOWNLOAD.store(true, Ordering::SeqCst);
        let mut out = Vec::new();
        let result = copy_hashed(&mut &b"abc"[..], &mut out, &|_| {});
        CANCEL_DOWNLOAD.store(false, Ordering::SeqCst);
        assert_eq!(result.unwrap_err(), "Download canceled.");
        assert!(out.is_empty());
    }

    #[test]
    fn verifies_size_and_pinned_hash() {
        assert!(verify(MODEL_BYTES, MODEL_SHA256).is_ok());
        assert!(verify(MODEL_BYTES - 1, MODEL_SHA256).is_err());
        assert!(verify(MODEL_BYTES, &"0".repeat(64)).is_err());
        assert_eq!(MODEL_SHA256.len(), 64);
    }

    #[test]
    fn part_file_is_removed_unless_kept() {
        let dir = scratch("part");
        let dropped = dir.join("a.part");
        std::fs::write(&dropped, b"x").unwrap();
        drop(PartFile::new(dropped.clone()));
        assert!(!dropped.exists());
        let kept = dir.join("b.part");
        std::fs::write(&kept, b"x").unwrap();
        PartFile::new(kept.clone()).keep();
        assert!(kept.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
