import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const localityMock = vi.hoisted(() => ({ session: "local" as string }));
vi.mock("../../server-locality/model/locality", async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import("../../server-locality/model/locality")
    >();
  return { ...real, sessionIsLocal: () => localityMock.session };
});

import { privacyView, type PrivacySession } from "./privacyView";
import {
  HARNESS_REPORT_TTL_MS,
  noteHarnessModelRoute,
  noteHarnessServers,
  registerHarnessConfigProbe,
} from "../../server-locality/model/sessionServers";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

const session = (cwd: string): PrivacySession => ({
  harness: "codex",
  runtimeMode: "supervised",
  cwd,
  blocks: [],
});

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
  localityMock.session = "local";
  // Codex on a wrapper home, with Ollama at 16k context.
  registerHarnessConfigProbe("codex", async () => null);
});
afterEach(() => {
  registerHarnessConfigProbe("codex", null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Private reads a fresh harness report only (R8)", () => {
  it("is Private with a fresh report and not once it is a minute old", () => {
    const cwd = "/work/fresh";
    noteHarnessServers("codex", undefined, cwd, []);
    noteHarnessModelRoute("codex", undefined, cwd, {
      provider: "ollama",
      baseUrls: { ollama: "http://127.0.0.1:11434/v1" },
      model: "qwen2.5-coder:7b",
    });
    expect(privacyView(session(cwd)).private).toBe(true);
    vi.setSystemTime(Date.now() + HARNESS_REPORT_TTL_MS + 1);
    const stale = privacyView(session(cwd));
    expect(stale.private).toBe(false);
    expect(stale.notPrivateBecause).toBe(
      "What its harness reported about its model and tools is more than a minute old",
    );
  });

  it("is not Private when the harness never reported", () => {
    expect(privacyView(session("/work/never")).private).toBe(false);
  });

  it("leaves a harness MonoCode cannot ask alone", () => {
    const cwd = "/work/none";
    noteHarnessServers("codex", undefined, cwd, []);
    noteHarnessModelRoute("codex", undefined, cwd, {
      provider: "ollama",
      baseUrls: { ollama: "http://127.0.0.1:11434/v1" },
    });
    registerHarnessConfigProbe("codex", null);
    vi.setSystemTime(Date.now() + HARNESS_REPORT_TTL_MS + 1);
    expect(privacyView(session(cwd)).private).toBe(true);
  });
});
