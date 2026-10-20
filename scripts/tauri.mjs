// `npm run tauri ...`: runs the project's Tauri CLI with `tauriArgs`, as an
// argument list, never through a shell.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tauriArgs } from "./tauri-args.mjs";

const require = createRequire(import.meta.url);
const cli = require.resolve("@tauri-apps/cli/tauri.js");

const child = spawn(process.execPath, [cli, ...tauriArgs(process.argv.slice(2))], {
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
child.on("error", (error) => {
  console.error(`tauri: ${error.message}`);
  process.exit(1);
});
