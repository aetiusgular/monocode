// `npm run tauri ...`: runs the project's Tauri CLI with `tauriArgs`, as an
// argument list, never through a shell.
//
// Its stdout and stderr pass through `InvokeKeyFilter`, which hides the line
// Tauri prints with the expected invoke key when a page sends a wrong one
// (research note AD; Mac test 0.8). Piping means the CLI and cargo no longer
// see a terminal, so their colours and cargo's progress bar are off; stdin
// stays the terminal's.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { InvokeKeyFilter } from "./invoke-key-filter.mjs";
import { tauriArgs } from "./tauri-args.mjs";

const require = createRequire(import.meta.url);
const cli = require.resolve("@tauri-apps/cli/tauri.js");

// After the CLI exits, how long its pipes may stay open. The dev server and
// the app hold copies of them (`tauri-cli-2.11.4/src/dev.rs:202-204`,
// `src/interface/rust/desktop.rs:73-74`); one left running would otherwise
// keep this wrapper alive with it.
const DRAIN_MS = 1500;

const child = spawn(
  process.execPath,
  [cli, ...tauriArgs(process.argv.slice(2))],
  {
    stdio: ["inherit", "pipe", "pipe"],
  },
);
child.stdout.pipe(new InvokeKeyFilter()).pipe(process.stdout);
child.stderr.pipe(new InvokeKeyFilter()).pipe(process.stderr);

// Ctrl+C reaches the whole process group. The CLI stops the dev server and
// the app itself; this wrapper stays up to pass on what they print while they
// stop, so a write to a closed pipe does not cut their shutdown short. A
// SIGTERM sent to this wrapper alone is passed on to the CLI. A second signal
// leaves at once.
let interrupts = 0;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(128 + constants.signals[signal]);
    if (signal === "SIGTERM") child.kill("SIGTERM");
  });
}

let drain;
child.on("exit", (code, signal) => {
  process.exitCode = signal
    ? 128 + (constants.signals[signal] ?? 1)
    : (code ?? 1);
  drain = setTimeout(() => {
    child.stdout.destroy();
    child.stderr.destroy();
  }, DRAIN_MS);
});
// "close" comes after both pipes have ended. Setting the exit code, rather
// than calling process.exit, lets the last filtered writes drain first.
child.on("close", () => clearTimeout(drain));
child.on("error", (error) => {
  console.error(`tauri: ${error.message}`);
  process.exit(1);
});
