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
import { InvokeKeyFilter } from "./invoke-key-filter.mjs";
import { tauriArgs } from "./tauri-args.mjs";

const require = createRequire(import.meta.url);
const cli = require.resolve("@tauri-apps/cli/tauri.js");

const child = spawn(process.execPath, [cli, ...tauriArgs(process.argv.slice(2))], {
  stdio: ["inherit", "pipe", "pipe"],
});
child.stdout.pipe(new InvokeKeyFilter()).pipe(process.stdout);
child.stderr.pipe(new InvokeKeyFilter()).pipe(process.stderr);
// "close" comes after both pipes have ended. Setting the exit code, rather
// than calling process.exit, lets the last filtered writes drain first.
child.on("close", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
child.on("error", (error) => {
  console.error(`tauri: ${error.message}`);
  process.exit(1);
});
