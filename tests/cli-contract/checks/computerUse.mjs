// Contract checks for computer use (wave 3, lane C), run by
// tests/cli-contract/run.mjs. They answer one question per harness: does the
// stdio MCP server a harness starts see the two variables MonoCode sets on
// the harness process (MONOCODE_CU_ENDPOINT, MONOCODE_CU_TOKEN)? The bridge
// reads the chat's token from there, so a harness that drops them would leave
// computer use unreachable.
//
// Kept beside the feature because lane C may not add files under tests/ in
// this wave; integration may move it to tests/cli-contract/checks/.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { codexHomeConfig, isolatedEnv, makeTempDirs } from "../lib/codexDriver.mjs";
import { ClaudeSession } from "../lib/claudeDriver.mjs";
import { startFakeMessages, textBlock } from "../lib/fakeMessages.mjs";
import { startFakeResponses, text } from "../lib/fakeResponses.mjs";

const ENDPOINT = "MONOCODE_CU_ENDPOINT";
const TOKEN = "MONOCODE_CU_TOKEN";
const FAKE_ENDPOINT = "127.0.0.1:9";
const FAKE_TOKEN = "contract-check-token-not-a-secret";
const SERVER = "monocode_computer_use";

// A stdio MCP server that writes which of the two variables it was given,
// and answers initialize and tools/list.
const PROBE = `
import { writeFileSync } from "node:fs";
const out = process.argv[2];
writeFileSync(out, JSON.stringify({
  endpoint: process.env.${ENDPOINT} ?? null,
  token: process.env.${TOKEN} === ${JSON.stringify(FAKE_TOKEN)} ? "matches" : (process.env.${TOKEN} ? "differs" : null),
}));
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue;
    const result = msg.method === "initialize"
      ? { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } }
      : msg.method === "tools/list" ? { tools: [] } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  }
});
`;

function waitForFile(file, ms) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (existsSync(file)) return resolve(JSON.parse(readFileSync(file, "utf8")));
      if (Date.now() - started > ms) return resolve(null);
      setTimeout(tick, 100);
    };
    tick();
  });
}

/** One Codex app-server run with the probe as a server; what the probe saw. */
async function codexProbe(codexPath, withEnvVars) {
  const dirs = makeTempDirs("cu-codex-");
  const probe = path.join(dirs.root, "probe.mjs");
  const out = path.join(dirs.root, "seen.json");
  writeFileSync(probe, PROBE);
  const fake = await startFakeResponses({ script: () => [text("ok")] });
  writeFileSync(path.join(dirs.codexHome, "config.toml"), codexHomeConfig({ baseUrl: fake.baseUrl }));
  // The flags MonoCode passes for the chat's computer-use server
  // (codexGatewayConfigArgs, plus env_vars under the [w3-c] hook in codex.ts).
  const args = [
    "app-server",
    "-c",
    `mcp_servers.${SERVER}.command=${JSON.stringify(process.execPath)}`,
    "-c",
    `mcp_servers.${SERVER}.args=${JSON.stringify([probe, out])}`,
  ];
  if (withEnvVars) args.push("-c", `mcp_servers.${SERVER}.env_vars=${JSON.stringify([ENDPOINT, TOKEN])}`);
  const child = spawn(codexPath, args, {
    cwd: dirs.work,
    env: isolatedEnv({ home: dirs.home, extra: { CODEX_HOME: dirs.codexHome, [ENDPOINT]: FAKE_ENDPOINT, [TOKEN]: FAKE_TOKEN } }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  let id = 1;
  const send = (method, params) => child.stdin.write(`${JSON.stringify(params === undefined ? { method } : { id: id++, method, params })}\n`);
  try {
    send("initialize", { clientInfo: { name: "monocode", title: "MonoCode", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    await new Promise((r) => setTimeout(r, 500));
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    send("thread/start", { cwd: dirs.work });
    return { seen: await waitForFile(out, 20000), stderr };
  } finally {
    child.kill("SIGTERM");
    await fake.close?.();
  }
}

async function codexEnvCheck({ codexPath }) {
  const without = await codexProbe(codexPath, false);
  const withVars = await codexProbe(codexPath, true);
  const reached = withVars.seen?.endpoint === FAKE_ENDPOINT && withVars.seen?.token === "matches";
  const dropped = !without.seen?.endpoint && !without.seen?.token;
  return {
    status: reached ? "pass" : "fail",
    finding: withVars.seen
      ? `With env_vars, the server saw endpoint ${withVars.seen.endpoint ? "yes" : "no"} and token ${withVars.seen.token ?? "no"}. ` +
        `Without env_vars it saw ${without.seen ? `endpoint ${without.seen.endpoint ? "yes" : "no"}, token ${without.seen.token ?? "no"}` : "nothing (did not start)"}: ` +
        `${dropped ? "Codex drops them unless named, so the flag is needed." : "Codex passes them on anyway."}`
      : `The probe server never started. Stderr: ${withVars.stderr.slice(-300)}`,
    seen: { with: withVars.seen, without: without.seen },
  };
}

async function claudeEnvCheck({ claudePath }) {
  const dirs = makeTempDirs("cu-claude-");
  const probe = path.join(dirs.root, "probe.mjs");
  const out = path.join(dirs.root, "seen.json");
  writeFileSync(probe, PROBE);
  const fake = await startFakeMessages({ script: () => [textBlock("ok")] });
  // The --mcp-config MonoCode builds (claudeGatewayMcpConfig).
  const config = JSON.stringify({ mcpServers: { [SERVER]: { type: "stdio", command: process.execPath, args: [probe, out] } } });
  const s = new ClaudeSession({
    claudePath,
    dirs,
    baseUrl: fake.baseUrl,
    args: ["--mcp-config", config],
    env: { [ENDPOINT]: FAKE_ENDPOINT, [TOKEN]: FAKE_TOKEN },
  });
  try {
    let seen = await waitForFile(out, 8000);
    if (!seen) {
      await s.send("hello", 60000);
      seen = await waitForFile(out, 8000);
    }
    const reached = seen?.endpoint === FAKE_ENDPOINT && seen?.token === "matches";
    return {
      status: reached ? "pass" : "fail",
      finding: seen
        ? `A --mcp-config stdio server saw endpoint ${seen.endpoint ? "yes" : "no"} and token ${seen.token ?? "no"}: Claude Code ${reached ? "passes" : "does not pass"} its environment on.`
        : `The probe server never started. Stderr: ${s.stderr.slice(-300)}`,
      seen,
    };
  } finally {
    try {
      await s.close();
    } catch {}
    await fake.close?.();
  }
}

export const computerUseCodexChecks = [
  {
    id: "cu-env-codex",
    title: "Computer use: the chat's MCP server gets MonoCode's endpoint and token on Codex",
    flag: "computer-use env_vars",
    run: codexEnvCheck,
  },
];

export const computerUseClaudeChecks = [
  {
    id: "cu-env-claude",
    title: "Computer use: the chat's MCP server gets MonoCode's endpoint and token on Claude Code",
    flag: "computer-use env",
    run: claudeEnvCheck,
  },
];
