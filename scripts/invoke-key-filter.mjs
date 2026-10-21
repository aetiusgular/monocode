// Keeps Tauri's invoke key out of the dev log.
//
// Tauri 2.11.5 checks the key a page sends with each IPC call. On a mismatch
// it prints the expected key with `eprintln!`, unless its `tracing` feature
// is on (`tauri-2.11.5/src/webview/mod.rs:1746-1761`). The feature cannot be
// on: it makes every `eval_script` wait for the main thread, so an `emit` from
// another thread deadlocks against the main thread taking the same lock
// (research note AD, Mac retest R0.8). So `npm run tauri` reads the CLI's
// output and replaces any line that carries the marker with a note that names
// no key (Mac test 0.8; rules section 5, item 1).
//
// Output is passed on as soon as it arrives, even mid-line, so prompts and
// progress text are not held back. Only a tail that could be the start of the
// marker waits for the next chunk, so the buffer never holds more than the
// marker's length.
//
// It also drops C0 and C1 control characters other than tab, newline and
// carriage return. The text after "received" in Tauri's line comes from the
// page, so a page could send a key holding a newline and terminal escape
// sequences (OSC 52 writes the clipboard); the line itself is hidden, and the
// escapes after its newline are dropped. With the output piped, cargo, the CLI
// and Vite print no colours anyway, so nothing they print is lost
// (security review, 21 Oct).
//
// What it covers: the dev log that `npm run tauri dev` prints. It does not
// cover a release build's stderr, which a Finder launch sends nowhere.

import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";

export const INVOKE_KEY_MARKER = "__TAURI_INVOKE_KEY__";
export const HIDDEN_LINE =
  "[monocode] a page sent a wrong IPC key; Tauri's line with the expected key was hidden";

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

function clean(text) {
  return text.replace(CONTROL, "");
}

// The longest tail of `text` that is a proper prefix of the marker.
function markerPrefixTail(text) {
  const max = Math.min(text.length, INVOKE_KEY_MARKER.length - 1);
  for (let n = max; n > 0; n--) {
    if (INVOKE_KEY_MARKER.startsWith(text.slice(text.length - n))) return n;
  }
  return 0;
}

export class InvokeKeyFilter extends Transform {
  constructor() {
    super();
    this.decoder = new StringDecoder("utf8");
    // Text not yet passed on: at most a possible start of the marker.
    this.pending = "";
    // Part of the current line was already passed on.
    this.midLine = false;
    // The current line held the marker: drop it up to its newline.
    this.dropping = false;
  }

  hidden() {
    const out = (this.midLine ? "\n" : "") + HIDDEN_LINE + "\n";
    this.midLine = false;
    return out;
  }

  _transform(chunk, _encoding, done) {
    done(null, this.take(this.decoder.write(chunk)));
  }

  _flush(done) {
    let out = this.take(this.decoder.end());
    if (!this.dropping) out += this.pending;
    this.pending = "";
    done(null, out);
  }

  take(text) {
    let rest = this.pending + clean(text);
    this.pending = "";
    let out = "";
    for (;;) {
      const end = rest.indexOf("\n");
      if (end < 0) break;
      const line = rest.slice(0, end);
      rest = rest.slice(end + 1);
      if (this.dropping) {
        this.dropping = false;
      } else if (line.includes(INVOKE_KEY_MARKER)) {
        out += this.hidden();
        continue;
      } else {
        out += line + "\n";
      }
      this.midLine = false;
    }
    if (this.dropping) return out;
    if (rest.includes(INVOKE_KEY_MARKER)) {
      // The key follows the marker on the same line: drop to the newline.
      out += this.hidden();
      this.dropping = true;
      return out;
    }
    const keep = markerPrefixTail(rest);
    const now = rest.slice(0, rest.length - keep);
    if (now) {
      out += now;
      this.midLine = true;
    }
    this.pending = rest.slice(rest.length - keep);
    return out;
  }
}
