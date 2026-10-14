import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Project files are served from memory; the real Codex is not run.
const files = new Map<string, string>();
const written = new Map<string, string>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "project_context_read") {
      const key = `${args.scope}:${args.project ?? ""}:${args.file}`;
      const text = files.get(key) ?? null;
      return { text, hash: `h${(text ?? "").length}` };
    }
    if (command === "project_context_save") {
      files.set(
        `${args.scope}:${args.project ?? ""}:${args.file}`,
        String(args.text),
      );
      return `h${String(args.text).length}`;
    }
    if (command === "session_preamble_write") {
      written.set(String(args.sessionId), String(args.text));
      return "/data/preamble.md";
    }
    return null;
  }),
  isTauri: () => false,
}));

import {
  codexMcpServerList,
  codexModelRoute,
} from "../../../integrations/harness/providers/codex/codexProtocol";
import { newSession, type Session } from "../../sessions/model/session";
import {
  __resetInstalled,
  __setInstalled,
  type InstalledConnector,
} from "../../gateway-connectors/model/installed";
import {
  gatewayOnAtFirstTurn,
  localModelRoute,
} from "../../gateway-connectors/model/localDefault";
import { gatewaySessionInput } from "../../gateway-connectors/model/sessionGateway";
import { resetTraitOverridesCache } from "../../model-traits/model/modelTraits";
import { privacyView } from "../../privacy-view/model/privacyView";
import {
  HARNESS_REPORT_TTL_MS,
  __resetHarnessServers,
  registerHarnessConfigProbe,
} from "../../server-locality/model/sessionServers";
import {
  isLocal,
  sessionIsLocal,
  sessionLocalityNow,
} from "../../server-locality/model/locality";
import { addProjectMemory } from "../../project-memory/model/projectMemory";
import { prepareSessionPreamble } from "./sessionPreamble";

/**
 * Mac finding 2.23, third pass. A brand new local Codex chat on the wrapper
 * home (corner case 13): Default account, no provider on the chat, no
 * Models-page provider for the account, the route known only from what the
 * session's own Codex reports through `config/read`. Eight gateway
 * connectors are installed and start off in a local chat. The panel said
 * Private, but the first turn's preamble left the local-only entry out.
 *
 * Cause: `sessionLocalityParts` built the gateway input without the chat's
 * folder, so before `gatewayOn` is saved the local default could not find
 * the route reported for that folder and fell back to the context window.
 * No window is set for the model here, as on the Mac, so the eight
 * connectors counted as on and hosted.
 */

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

/** Codex 0.161.0's `config/read` for the wrapper home, trimmed. */
const CONFIG_READ_WRAPPER = {
  config: {
    model: "qwen2.5:7b",
    model_provider: "ollama_local",
    model_providers: {
      ollama_local: { name: "Ollama", base_url: "http://127.0.0.1:11434/v1" },
    },
    mcp_servers: null,
    profile: null,
  },
  origins: {},
};
/** The same home edited to a hosted provider. */
const CONFIG_READ_HOSTED = {
  config: {
    model: "qwen2.5:7b",
    model_provider: "openrouter",
    model_providers: {
      openrouter: { name: "OR", base_url: "https://openrouter.ai/api/v1" },
    },
    mcp_servers: null,
    profile: null,
  },
  origins: {},
};

function probeAnswering(result: unknown) {
  const probe = vi.fn(async () => ({
    servers: codexMcpServerList(result) ?? [],
    route: codexModelRoute(result) ?? undefined,
  }));
  registerHarnessConfigProbe("codex", probe);
  return probe;
}

function connector(server: string, kind: "remote" | "container") {
  return {
    profileId: `monocode_${server.replace(/[^a-z0-9]/g, "_")}`,
    server,
    title: server,
    description: "",
    kind,
    ...(kind === "container" ? { image: `mcp/${server}` } : {}),
    auth: "none",
    sessionName: server,
    secrets: [],
    missingSecrets: [],
    settings: [],
    missingSettings: [],
    setup: "complete",
    test: { at: 1, ok: true, tools: 3, output: "" },
    status: "ready",
  } as InstalledConnector;
}

/** The eight connectors of the Mac's catalog; most are hosted. */
const EIGHT = [
  connector("context7-keyless", "remote"),
  connector("dotnet-types-explorer", "container"),
  connector("exa-remote", "remote"),
  connector("granola-remote", "remote"),
  connector("hugging-face", "remote"),
  connector("notion-remote", "remote"),
  connector("shopify-remote", "remote"),
  connector("time", "container"),
];

const CWD = "/Users/t/s7-gen";
const TODAY = new Date("2026-10-13T12:00:00Z");

/** The chat as `submitSession` passes it on its first turn. */
function firstTurnChat(over: Partial<Session> = {}): Session {
  return {
    ...newSession("codex", CWD, "codex:qwen2.5:7b"),
    id: "local-new",
    ...over,
  };
}

/** What the side panel shows for the same chat (`usePrivacyView`). */
function panel(chat: Session) {
  return privacyView(
    { ...chat, blocks: [] },
    {
      gatewayServers: gatewaySessionInput(chat, chat.worktreeCwd || chat.cwd)
        .servers,
      outboundOn: () => true,
    },
  );
}

async function preambleText(chat: Session): Promise<string> {
  const prepared = await prepareSessionPreamble({
    session: chat,
    project: CWD,
    commandFirst: false,
  });
  if (prepared.preambleFile) return written.get(chat.id) ?? "";
  return prepared.developerInstructions ?? prepared.messageBlock;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TODAY);
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
  resetTraitOverridesCache();
  __resetHarnessServers();
  __resetInstalled();
  __setInstalled({
    connectors: EIGHT,
    docker: "/usr/local/bin/docker",
    dockerState: "ready",
    loading: false,
    at: 1,
  });
  files.clear();
  written.clear();
  // The hand-written form, and one entry the app wrote as local.
  files.set(
    `project:${CWD}:MEMORY.md`,
    "- 2026-10-12 · The team color is TEAL.\n[local] The secret fruit is KIWI.\n",
  );
});

afterEach(() => {
  __resetInstalled();
  vi.useRealTimers();
});

describe("2.23: the first turn of a new wrapper-home chat", () => {
  it("gets the local-only entry the panel promises", async () => {
    const probe = probeAnswering(CONFIG_READ_WRAPPER);
    const chat = firstTurnChat();
    const text = await preambleText(chat);
    expect(probe).toHaveBeenCalled();
    expect(text).toContain("The team color is TEAL.");
    expect(text).toContain("The secret fruit is KIWI.");
    // The panel, on the same report, says Private, and the connectors start off.
    expect(localModelRoute(chat)).toBe(true);
    expect(gatewayOnAtFirstTurn(chat)).toEqual([]);
    expect(panel(chat).private).toBe(true);
  });

  it("an entry the app wrote as local reaches it too", async () => {
    probeAnswering(CONFIG_READ_WRAPPER);
    files.set(
      `project:${CWD}:MEMORY.md`,
      "- 2026-10-12 · The team color is TEAL.\n",
    );
    await addProjectMemory(CWD, "The secret fruit is KIWI.", {
      local: true,
      now: TODAY,
    });
    expect(files.get(`project:${CWD}:MEMORY.md`)).toContain(
      "- 2026-10-13 · [local] The secret fruit is KIWI.",
    );
    const text = await preambleText(firstTurnChat());
    expect(text).toContain("TEAL");
    expect(text).toContain("The secret fruit is KIWI.");
  });

  it("the same chat after its first message, with the saved off list, agrees", async () => {
    probeAnswering(CONFIG_READ_WRAPPER);
    const before = firstTurnChat();
    await sessionLocalityNow(before);
    const after: Session = {
      ...before,
      providerAccountId: "default",
      gatewayOn: gatewayOnAtFirstTurn(before),
      blocks: [{ id: "u1", role: "user", text: "What is the secret fruit?" }],
    };
    expect(isLocal(sessionIsLocal(before))).toBe(true);
    expect(isLocal(sessionIsLocal(after))).toBe(true);
    expect(panel(after).private).toBe(true);
    expect(await preambleText(after)).toContain("KIWI");
  });

  it("a chat in a worktree reads the route reported for its worktree", async () => {
    probeAnswering(CONFIG_READ_WRAPPER);
    const chat = firstTurnChat({ worktreeCwd: `${CWD}/.wt/one` });
    expect(await preambleText(chat)).toContain("KIWI");
    expect(panel(chat).private).toBe(true);
  });

  it("a home edited to a hosted provider keeps it out, and the panel agrees", async () => {
    probeAnswering(CONFIG_READ_HOSTED);
    const chat = firstTurnChat();
    const text = await preambleText(chat);
    expect(text).toContain("TEAL");
    expect(text).not.toContain("KIWI");
    expect(panel(chat).private).toBe(false);
  });

  it("a report that never comes keeps it out, and the panel agrees (unknown is hosted)", async () => {
    registerHarnessConfigProbe("codex", async () => {
      throw new Error("Codex did not report its MCP servers in time");
    });
    const chat = firstTurnChat();
    expect(await preambleText(chat)).not.toContain("KIWI");
    expect(panel(chat).private).toBe(false);
  });

  it("a report older than a minute is read again before the entry goes", async () => {
    const probe = probeAnswering(CONFIG_READ_WRAPPER);
    const chat = firstTurnChat();
    await sessionLocalityNow(chat);
    vi.setSystemTime(new Date(TODAY.getTime() + HARNESS_REPORT_TTL_MS + 1));
    // The home was edited to a hosted provider in that minute.
    probeAnswering(CONFIG_READ_HOSTED);
    expect(await preambleText(chat)).not.toContain("KIWI");
    expect(panel(chat).private).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("a hosted connector switched on for the chat keeps it out (corner case 8)", async () => {
    probeAnswering(CONFIG_READ_WRAPPER);
    const chat = firstTurnChat({ gatewayOn: ["exa-remote"] });
    expect(await preambleText(chat)).not.toContain("KIWI");
    expect(panel(chat).private).toBe(false);
  });

  it("a hosted chat beside it never gets it (corner case 7)", async () => {
    probeAnswering(CONFIG_READ_WRAPPER);
    const claude: Session = {
      ...newSession("claude", CWD, "claude:sonnet-5"),
      id: "hosted",
    };
    const text = await preambleText(claude);
    expect(text).toContain("TEAL");
    expect(text).not.toContain("KIWI");
  });
});
