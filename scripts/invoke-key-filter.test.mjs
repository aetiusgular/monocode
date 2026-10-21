import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  HIDDEN_LINE,
  INVOKE_KEY_MARKER,
  InvokeKeyFilter,
} from "./invoke-key-filter.mjs";

// Tauri 2.11.5's own line, `tauri/src/webview/mod.rs:1756-1759`.
const KEY = "a1b2c3d4e5f6a7b8c9d0";
const TAURI_LINE = `${INVOKE_KEY_MARKER} expected ${KEY} but received guessed-key-r08\n`;

// Feeds `chunks` through one filter; returns everything it passed on, and
// what it had passed on after each chunk.
function run(chunks) {
  const filter = new InvokeKeyFilter();
  const seen = [];
  let out = "";
  filter.on("data", (data) => {
    out += data.toString("utf8");
  });
  for (const chunk of chunks) {
    filter.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    seen.push(out);
  }
  filter.end();
  return { out, seen };
}

test("Tauri's wrong-key line is replaced and the key never passes", () => {
  const { out } = run([`Compiling monocode\n${TAURI_LINE}Finished\n`]);
  assert.equal(out, `Compiling monocode\n${HIDDEN_LINE}\nFinished\n`);
  assert.ok(!out.includes(KEY));
});

test("a marker split at every point across two chunks is still hidden", () => {
  const text = `before\n${TAURI_LINE}after\n`;
  for (let cut = 1; cut < text.length; cut++) {
    const { out } = run([text.slice(0, cut), text.slice(cut)]);
    assert.ok(!out.includes(KEY), `cut ${cut}: ${JSON.stringify(out)}`);
    assert.equal(out, `before\n${HIDDEN_LINE}\nafter\n`, `cut ${cut}`);
  }
});

test("a line fed one byte at a time is still hidden", () => {
  const { out } = run(
    [...Buffer.from(TAURI_LINE)].map((byte) => Buffer.from([byte])),
  );
  assert.ok(!out.includes(KEY));
  assert.equal(out, `${HIDDEN_LINE}\n`);
});

test("ordinary output passes unchanged, and a partial line is not held back", () => {
  const { out, seen } = run([
    "Running `target/debug/monocode`",
    " ok\nVITE ready\r\n",
    "? Port 1420 in use, use another one? ",
  ]);
  assert.equal(seen[0], "Running `target/debug/monocode`");
  assert.equal(
    out,
    "Running `target/debug/monocode` ok\nVITE ready\r\n? Port 1420 in use, use another one? ",
  );
});

test("only a possible start of the marker waits for the next chunk", () => {
  const { seen, out } = run([
    "warn: __TAURI_INV",
    "OKE_KEY__ expected secret\nnext\n",
  ]);
  assert.equal(seen[0], "warn: ");
  assert.equal(out, `warn: \n${HIDDEN_LINE}\nnext\n`);
  assert.ok(!out.includes("secret"));
});

test("the marker mid-line, after text already passed on, hides the rest of the line", () => {
  const { out } = run([
    "prefix text ",
    `${INVOKE_KEY_MARKER} expected ${KEY}`,
    " more\nnext line\n",
  ]);
  assert.equal(out, `prefix text \n${HIDDEN_LINE}\nnext line\n`);
  assert.ok(!out.includes(KEY));
});

test("a last line with no newline is hidden at the end", () => {
  const { out } = run([`${INVOKE_KEY_MARKER} expected ${KEY}`]);
  assert.equal(out, `${HIDDEN_LINE}\n`);
});

test("a UTF-8 character split across chunks arrives whole", () => {
  const bytes = Buffer.from("Généré ✓ ready\n");
  for (let cut = 1; cut < bytes.length; cut++) {
    const { out } = run([bytes.subarray(0, cut), bytes.subarray(cut)]);
    assert.equal(out, "Généré ✓ ready\n", `cut ${cut}`);
  }
});

test("a long stream with no newline is passed on, not buffered", () => {
  const big = "x".repeat(1 << 20);
  const { seen } = run([big]);
  assert.equal(seen[0].length, big.length);
});

test("terminal escapes a page puts after its key never reach the terminal", () => {
  const evil = `${INVOKE_KEY_MARKER} expected ${KEY} but received x\n\u001b]52;c;cHduZWQ=\u0007fake line\n`;
  const { out } = run([evil]);
  // The escape bytes are gone; what is left is inert text.
  assert.equal(out, `${HIDDEN_LINE}\n]52;c;cHduZWQ=fake line\n`);
  assert.ok(
    !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(out.replaceAll("\n", "")),
  );
});

test("cargo's colour codes pass, even split across chunks", () => {
  const text = "\u001b[1m\u001b[92m     Running\u001b[0m `monocode`\n";
  for (let cut = 1; cut < text.length; cut++) {
    const { out } = run([text.slice(0, cut), text.slice(cut)]);
    assert.equal(out, text, `cut ${cut}`);
  }
});

test("tabs and carriage returns pass, other control characters do not", () => {
  const { out } = run(["a\tb\r\nc\u0007\u009bd\n"]);
  assert.equal(out, "a\tb\r\ncd\n");
});

test("npm run tauri sends both of the CLI's streams through the filter", () => {
  const source = readFileSync(new URL("./tauri.mjs", import.meta.url), "utf8");
  assert.match(source, /stdio: \["inherit", "pipe", "pipe"\]/);
  assert.match(
    source,
    /child\.stdout\.pipe\(new InvokeKeyFilter\(\)\)\.pipe\(process\.stdout\)/,
  );
  assert.match(
    source,
    /child\.stderr\.pipe\(new InvokeKeyFilter\(\)\)\.pipe\(process\.stderr\)/,
  );
});

test("the wrapper does not wait forever on pipes a leftover process holds", () => {
  const source = readFileSync(new URL("./tauri.mjs", import.meta.url), "utf8");
  assert.match(
    source,
    /child\.on\("exit"[\s\S]*child\.stdout\.destroy\(\)[\s\S]*child\.stderr\.destroy\(\)/,
  );
  assert.match(source, /process\.on\(signal,/);
});
