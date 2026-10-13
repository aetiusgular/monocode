// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import {
  sessionToolsInput,
  withSessionToolsPatch,
} from "../../session-tools/model/harnessInput";
import { newTab } from "../../workspace/model/layout";
import {
  collectWorkspaceSnapshot,
  hydrateWorkspaceSnapshot,
  parseWorkspaceSnapshot,
} from "../../workspace/model/workspaceSnapshot";
import { saveModelProvider } from "../../model-setup/model/modelProviders";
import {
  resetTraitOverridesCache,
  saveTraitOverride,
} from "../../model-traits/model/modelTraits";
import { sessionIsLocal } from "../../server-locality/model/locality";
import type { InstalledConnector, InstalledState } from "./installed";
import { __resetInstalled, __setInstalled } from "./installed";
import {
  gatewayOnAtFirstTurn,
  LOCAL_DEFAULT_NOTE,
  localModelRoute,
  withGatewayOn,
} from "./localDefault";
import { gatewayOffByDefault, gatewaySessionInput } from "./sessionGateway";

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => []);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
const { getSession, sanitizeSessionForPersist } =
  await import("../../sessions/data/sessionStore");
const { ConnectorsPopover } =
  await import("../../session-tools/ui/ConnectorsPopover");

/**
 * Mac test 1.3, the user's decision of 12 Oct: a new Codex chat on a local
 * model starts with every gateway connector off, because Codex sends every
 * connector's tools with every request. Claude Code chats and hosted Codex
 * chats keep them on.
 */

function connector(server: string, title: string): InstalledConnector {
  return {
    profileId: `monocode_${server.replace(/[^a-z0-9]/g, "_")}`,
    server,
    title,
    description: "",
    kind: "remote",
    auth: "none",
    sessionName: server,
    secrets: [],
    missingSecrets: [],
    settings: [],
    missingSettings: [],
    setup: "complete",
    test: { at: 1, ok: true, tools: 3, output: "" },
    status: "ready",
  };
}

const NAMES = [
  "context7-keyless",
  "dotnet-types-explorer",
  "exa-remote",
  "granola-remote",
  "hugging-face",
  "notion-remote",
  "shopify-remote",
  "time",
];
const STATE: InstalledState = {
  connectors: NAMES.map((name) => connector(name, name)),
  docker: "/usr/local/bin/docker",
  dockerState: "ready",
  loading: false,
  at: 1,
};

/** A chat on the wrapper home: its model is Qwen 7B at 16k (Settings, Models). */
function localWrapperChat(): Session {
  return { ...newSession("codex", "/repo", "codex:qwen2.5:7b"), id: "local-1" };
}

const startedNames = (session: Session) =>
  (sessionToolsInput(session, "/repo").gatewayConnectors ?? []).map(
    (s) => s.name,
  );

beforeEach(() => {
  localStorage.clear();
  resetTraitOverridesCache();
  __resetInstalled();
  __setInstalled(STATE);
  saveTraitOverride("codex:qwen2.5:7b", { contextWindow: 16_384 });
});

afterEach(() => {
  __resetInstalled();
});

describe("which chats count as on a local model", () => {
  it("a provider on loopback, a hosted provider, and a small window when unknown", () => {
    saveModelProvider({
      id: "ollama_local",
      label: "Ollama on this Mac",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
    });
    const base = newSession("codex", "/repo", "codex:gpt-5.4");
    expect(localModelRoute({ ...base, modelProvider: "ollama_local" })).toBe(
      true,
    );
    expect(localModelRoute({ ...base, modelProvider: "openai" })).toBe(false);
    // Unknown provider: the 7B's 16k window counts as small; a big one does not.
    expect(localModelRoute(localWrapperChat())).toBe(true);
    saveTraitOverride("codex:gpt-5.4", { contextWindow: 272_000 });
    expect(localModelRoute(base)).toBe(false);
    // Claude Code never.
    expect(localModelRoute(newSession("claude", "/repo"))).toBe(false);
  });
});

describe("gateway connectors on a local model", () => {
  it("a new local Codex chat starts with every connector off", () => {
    const chat = localWrapperChat();
    expect(startedNames(chat)).toEqual([]);
    expect(gatewaySessionInput(chat, "/repo").onlyOn).toEqual([]);
    expect(gatewayOffByDefault(chat, "/repo")).toEqual(NAMES);
    // The first message saves the state on the chat.
    expect(gatewayOnAtFirstTurn(chat)).toEqual([]);
  });

  it("switching one on keeps it on, through a save and a snapshot", async () => {
    let chat = localWrapperChat();
    chat = withSessionToolsPatch(chat, {
      gatewayOn: withGatewayOn(
        gatewaySessionInput(chat, "/repo").onlyOn!,
        "time",
        true,
      ),
    });
    expect(chat.gatewayOn).toEqual(["time"]);
    expect(startedNames(chat)).toEqual(["time"]);

    // A tab that has not sent a message yet: the workspace snapshot.
    const tab = newTab(chat.id);
    const snapshot = JSON.parse(
      JSON.stringify(
        collectWorkspaceSnapshot([tab], [chat], tab.id, chat.cwd, new Map()),
      ),
    );
    const restored = hydrateWorkspaceSnapshot(
      parseWorkspaceSnapshot(snapshot)!,
      new Map(),
      new Set(),
    )!.sessions[0];
    expect(restored.gatewayOn).toEqual(["time"]);
    expect(startedNames(restored)).toEqual(["time"]);

    // After the first message: the saved chat, read back.
    const sent: Session = {
      ...chat,
      blocks: [{ id: "u1", role: "user", text: "what time is it" }],
    };
    const saved = JSON.parse(JSON.stringify(sanitizeSessionForPersist(sent)));
    invoke.mockImplementation(async (cmd) =>
      cmd === "session_get" ? saved : null,
    );
    const loaded = (await getSession(chat.id))!;
    expect(loaded.gatewayOn).toEqual(["time"]);
    expect(startedNames(loaded)).toEqual(["time"]);
    // An empty list is kept too: all off stays all off.
    const allOff = JSON.parse(
      JSON.stringify(sanitizeSessionForPersist({ ...sent, gatewayOn: [] })),
    );
    invoke.mockImplementation(async (cmd) =>
      cmd === "session_get" ? allOff : null,
    );
    expect((await getSession(chat.id))!.gatewayOn).toEqual([]);
  });

  it("a Claude Code chat starts with them on", () => {
    const chat = { ...newSession("claude", "/repo"), id: "c1" };
    expect(startedNames(chat)).toEqual(NAMES);
    expect(gatewayOnAtFirstTurn(chat)).toBeUndefined();
  });

  it("a hosted Codex chat starts with them on", () => {
    const chat: Session = {
      ...newSession("codex", "/repo", "codex:gpt-5.4"),
      id: "h1",
      modelProvider: "openai",
    };
    expect(startedNames(chat)).toEqual(NAMES);
    expect(gatewayOnAtFirstTurn(chat)).toBeUndefined();
  });

  it("an existing chat keeps its current state", () => {
    const existing: Session = {
      ...localWrapperChat(),
      blocks: [{ id: "u1", role: "user", text: "earlier turn" }],
      disabledMcpServers: ["exa-remote"],
    };
    expect(startedNames(existing)).toEqual(
      NAMES.filter((n) => n !== "exa-remote"),
    );
    expect(gatewayOnAtFirstTurn(existing)).toBeUndefined();
  });

  it("with every connector off, a local chat reads as local", () => {
    saveModelProvider({
      id: "ollama_local",
      label: "Ollama on this Mac",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
    });
    const chat: Session = {
      ...localWrapperChat(),
      modelProvider: "ollama_local",
    };
    expect(sessionIsLocal(chat, [])).toBe("local");
  });
});

describe("the Connectors popover on a local model", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function render(session: Session, onGatewayOnChange = vi.fn()) {
    const anchor = { current: container };
    act(() =>
      root.render(
        createElement(ConnectorsPopover, {
          anchor,
          harness: session.harness,
          sessionId: session.id,
          cwd: "/repo",
          disabled: session.disabledMcpServers ?? [],
          atTurnStart: null,
          onChange: vi.fn(),
          onManage: vi.fn(),
          onDismiss: vi.fn(),
          localDefault: session,
          onGatewayOnChange,
        }),
      ),
    );
    return onGatewayOnChange;
  }
  const switchFor = (name: string) =>
    document.querySelector<HTMLButtonElement>(
      `[role=switch][aria-label="${name}"]`,
    );

  it("says why, shows every connector off, and switches one on for this chat", () => {
    const onGatewayOnChange = render(localWrapperChat());
    expect(document.body.textContent).toContain(LOCAL_DEFAULT_NOTE);
    expect(switchFor("time")?.getAttribute("aria-checked")).toBe("false");
    act(() => switchFor("time")!.click());
    expect(onGatewayOnChange).toHaveBeenCalledWith(["time"]);
  });

  it("shows no note on a Claude Code chat", () => {
    render({ ...newSession("claude", "/repo"), id: "c1" });
    expect(document.body.textContent).not.toContain(LOCAL_DEFAULT_NOTE);
  });
});
