// The arguments `npm run tauri` hands to the Tauri CLI.
//
// `tauri dev` gets the dev config first, so the dev build runs as
// `com.monocode.desktop.dev` with its own data folder and its own macOS
// permission entries, apart from the installed app (your decision of 20 Oct
// 2026; research note AA, finding 4.4). The CLI merges every `--config` in
// the order given, later values winning (https://v2.tauri.app/reference/cli/),
// so a config you pass yourself still applies on top. Every other command,
// `tauri build` included, is passed through unchanged.

export const DEV_CONFIG = "src-tauri/tauri.dev.conf.json";

export function tauriArgs(args) {
  if (args[0] !== "dev") return [...args];
  return ["dev", "--config", DEV_CONFIG, ...args.slice(1)];
}
