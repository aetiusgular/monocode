// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

import { newSession } from "../../sessions/model/session";
import {
  resetTraitOverridesCache,
  saveTraitOverride,
} from "../../model-traits/model/modelTraits";
import {
  __resetHarnessServers,
  noteHarnessModelRoute,
} from "../../server-locality/model/sessionServers";
import { localModelRoute } from "./localDefault";

/**
 * Security fix F9: with no provider on the chat or its account, the gateway
 * default judged a wrapper-home Codex chat by its context window only and
 * ignored the route that Codex reported from its own home.
 */

const CWD = "/Users/t/s7-gen";

beforeEach(() => {
  localStorage.clear();
  resetTraitOverridesCache();
  __resetHarnessServers();
  saveTraitOverride("codex:qwen2.5:7b", { contextWindow: 16_384 });
  saveTraitOverride("codex:gpt-5.4", { contextWindow: 272_000 });
});

const reportLocal = () =>
  noteHarnessModelRoute("codex", "default", CWD, {
    provider: "ollama_local",
    baseUrls: { ollama_local: "http://127.0.0.1:11434/v1" },
  });
const reportHosted = () =>
  noteHarnessModelRoute("codex", "default", CWD, {
    provider: "openrouter",
    baseUrls: { openrouter: "https://openrouter.ai/api/v1" },
  });

describe("the gateway local default reads the reported route (F9)", () => {
  it("a wrapper home on loopback is local whatever the window", () => {
    const chat = newSession("codex", CWD, "codex:gpt-5.4");
    expect(localModelRoute(chat)).toBe(false);
    reportLocal();
    expect(localModelRoute(chat)).toBe(true);
  });

  it("a wrapper home on a hosted provider is not local, even with a small window", () => {
    const chat = newSession("codex", CWD, "codex:qwen2.5:7b");
    expect(localModelRoute(chat)).toBe(true);
    reportHosted();
    expect(localModelRoute(chat)).toBe(false);
  });

  it("an Ollama cloud model is never local", () => {
    // Even with a small window and no route reported.
    saveTraitOverride("codex:gpt-oss:120b-cloud", { contextWindow: 16_384 });
    expect(
      localModelRoute(newSession("codex", CWD, "codex:gpt-oss:120b-cloud")),
    ).toBe(false);
  });

  it("a route reported for another folder does not count", () => {
    reportLocal();
    expect(
      localModelRoute(newSession("codex", "/Users/t/other", "codex:gpt-5.4")),
    ).toBe(false);
  });
});
