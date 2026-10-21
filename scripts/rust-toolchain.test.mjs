import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Mac retest R0.6: one Rust for the cloud and the Mac, so clippy's
// `-D warnings` gate is the same on both.
const file = readFileSync(new URL("../rust-toolchain.toml", import.meta.url), "utf8");
const setting = (key) => {
  const line = file.split("\n").find((l) => l.startsWith(`${key} = `));
  return line && line.slice(key.length + 3).trim();
};

test("the toolchain is pinned to an exact release with clippy and rustfmt", () => {
  assert.match(setting("channel"), /^"\d+\.\d+\.\d+"$/);
  assert.equal(setting("components"), '["clippy", "rustfmt"]');
});

test("no target is listed, so the cloud never has to download one", () => {
  assert.equal(setting("targets"), undefined);
});

test("the rustc this repository runs is the pinned one", (t) => {
  let version;
  try {
    version = execFileSync("rustc", ["--version"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      timeout: 60_000,
    });
  } catch {
    t.skip("rustc is not installed here, or the pinned toolchain is missing");
    return;
  }
  const pinned = JSON.parse(setting("channel"));
  assert.ok(version.startsWith(`rustc ${pinned} `), version);
});
