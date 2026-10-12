import { invoke } from "@tauri-apps/api/core";
import {
  harnessCapabilities,
  type EnvDelivery,
} from "../../../integrations/harness/core/capabilities";
import type { HarnessId } from "../../sessions/model/session";

/**
 * #28: variables every harness starts with, global and per project. Plain
 * values live in the app's data folder; a secret lives in the OS keychain
 * and never comes back here (`env_store.rs`). MonoCode applies them when it
 * starts a harness, so every harness gets them, and the agent can read them.
 */
export type EnvVar = { name: string; secret: boolean; value: string | null };
export type EnvView = { global: EnvVar[]; projects: Record<string, EnvVar[]> };

export function loadEnv(): Promise<EnvView> {
  return invoke<EnvView>("env_store_load");
}

export function setEnvVar(input: {
  project?: string;
  name: string;
  value: string;
  secret: boolean;
}): Promise<void> {
  return invoke("env_store_set", {
    project: input.project ?? null,
    name: input.name,
    value: input.value,
    secret: input.secret,
  });
}

export function removeEnvVar(
  project: string | undefined,
  name: string,
): Promise<void> {
  return invoke("env_store_remove", { project: project ?? null, name });
}

/** The same rule as the Rust side, to answer before a round trip. */
export const RESERVED_ENV = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "USERPROFILE",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "NODE_OPTIONS",
]);
const RESERVED_PREFIXES = ["MONOCODE_", "DYLD_", "LD_"];

export function envNameProblem(name: string): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))
    return "Letters, digits and _, not starting with a digit.";
  const upper = name.toUpperCase();
  if (
    RESERVED_ENV.has(upper) ||
    RESERVED_PREFIXES.some((p) => upper.startsWith(p))
  )
    return `${name} is reserved. API keys belong under Providers.`;
  return undefined;
}

/**
 * What reaches a harness's tools, by harness. The capability table says
 * whether the harness inherits values at all; the rest is what each one is
 * known to pass on (step 3c plan, #28).
 */
const TOOL_NOTES: Partial<Record<HarnessId, string>> = {
  codex:
    "Shell commands get them. Its MCP servers do not: Codex starts them with a fixed list.",
  hermes:
    "Its terminal drops some credential names, such as OPENAI_API_KEY and GH_TOKEN.",
  claude:
    "Its shell commands get them. Whether its MCP servers do is not checked.",
};

export function envNote(harness: HarnessId): string {
  const delivery: EnvDelivery = harnessCapabilities(harness).env;
  if (delivery === "service")
    return "Runs one shared service for every chat, so these values do not reach it yet.";
  return (
    TOOL_NOTES[harness] ??
    "Starts with them; what reaches its tools is not known."
  );
}
