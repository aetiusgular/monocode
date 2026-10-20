import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEV_CONFIG, tauriArgs } from "./tauri-args.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));

test("npm run tauri goes through the wrapper", () => {
  assert.equal(pkg.scripts.tauri, "node scripts/tauri.mjs");
});

test("tauri dev gets the dev config first", () => {
  assert.deepEqual(tauriArgs(["dev"]), ["dev", "--config", DEV_CONFIG]);
  assert.deepEqual(tauriArgs(["dev", "--no-watch", "--config", "x.json"]), [
    "dev",
    "--config",
    DEV_CONFIG,
    "--no-watch",
    "--config",
    "x.json",
  ]);
});

test("every other command is unchanged", () => {
  for (const args of [["build"], ["build", "--bundles", "deb"], [], ["info"]]) {
    assert.deepEqual(tauriArgs(args), args);
  }
});

test("the dev config gives the dev identifier and nothing else", () => {
  const config = JSON.parse(
    readFileSync(new URL(`../${DEV_CONFIG}`, import.meta.url)),
  );
  assert.deepEqual(config, {
    identifier: "com.monocode.desktop.dev",
    productName: "MonoCode Dev",
  });
});

test("the stable dev script also runs as the dev identifier", () => {
  assert.match(pkg.scripts["tauri:stable"], /^node scripts\/tauri\.mjs dev /);
});
