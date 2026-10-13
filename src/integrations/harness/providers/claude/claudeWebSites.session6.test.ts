// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent, HarnessToolAccess } from "../../core/types";

/**
 * Web fetches ask per website (user's decision of 12 Oct), and browser-use's
 * plugin tools get the site card (Mac test 5.16). The WebFetch request below
 * has the shape Claude Code 2.1.296 sends, captured with the contract harness.
 */

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => true }));
vi.mock("../../core/existingDirs", () => ({
  existingDirs: async (dirs?: readonly string[]) => [...(dirs ?? [])],
}));
vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));

const {
  respondClaudeApproval,
  sendClaudeTurn,
  stopClaudeSession,
  __claudeTestReset,
} = await import("./claude");
const { rememberSiteRule } =
  await import("../../../../features/browser-tools/model/siteRules");

const parse = () =>
  sent.map((line) => JSON.parse(line) as Record<string, unknown>);
const emit = (rec: Record<string, unknown>) => onLine!(JSON.stringify(rec));
const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

async function startTurn(
  toolAccess?: HarnessToolAccess,
  options: {
    sessionId?: string;
    runtimeMode?: "supervised" | "full-access";
  } = {},
) {
  const events: HarnessEvent[] = [];
  const turn = sendClaudeTurn({
    sessionId: options.sessionId ?? "s1",
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: options.runtimeMode ?? "supervised",
    toolAccess,
    text: "run the tests",
    attachments: [],
    onEvent: (event) => events.push(event),
  });
  await waitFor(
    () =>
      parse().some(
        (m) =>
          (m.request as Record<string, unknown> | undefined)?.subtype ===
          "initialize",
      ),
    "initialize",
  );
  emit({ type: "system", subtype: "init", session_id: "sess_1" });
  emit({
    type: "control_response",
    response: { subtype: "success", request_id: "monocode_1" },
  });
  await waitFor(() => parse().some((m) => m.type === "user"), "user prompt");
  return { events, turn };
}

function ask(
  requestId: string,
  toolName: string,
  input: Record<string, unknown>,
) {
  emit({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: toolName,
      display_name: toolName,
      input,
      description: String(input.url ?? toolName),
      ...(toolName === "WebFetch"
        ? {
            permission_suggestions: [
              {
                type: "addRules",
                destination: "localSettings",
                rules: [
                  { toolName: "WebFetch", ruleContent: "domain:example.com" },
                ],
                behavior: "allow",
              },
            ],
          }
        : {}),
      tool_use_id: `use_${requestId}`,
    },
  });
}
const fetchUrl = (url: string) => ({ url, prompt: "Summarize the page" });

const responseFor = (requestId: string) =>
  parse().find(
    (m) => (m.response as Record<string, unknown>)?.request_id === requestId,
  );
async function answer(requestId: string) {
  await waitFor(() => !!responseFor(requestId), `answer to ${requestId}`);
  return (
    responseFor(requestId)!.response as { response: Record<string, unknown> }
  ).response;
}
const cards = (events: HarnessEvent[]) =>
  events.filter(
    (e): e is Extract<HarnessEvent, { type: "approval.requested" }> =>
      e.type === "approval.requested",
  );

async function finish(turn: Promise<void>) {
  emit({ type: "result", subtype: "success", session_id: "sess_1" });
  await turn;
}

beforeEach(() => {
  sent.length = 0;
  onLine = undefined;
  localStorage.clear();
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("s1");
  await stopClaudeSession("s2");
});

describe("WebFetch asks per website", () => {
  it("shows the site card with the host, the full address and the prompt", async () => {
    const { events, turn } = await startTurn();
    ask("r1", "WebFetch", fetchUrl("https://Example.com/a?b=1"));
    await waitFor(() => cards(events).length === 1, "card");
    expect(cards(events)[0].site).toEqual({
      server: "Claude",
      host: "example.com",
      hosts: ["example.com"],
      ruleable: true,
      fetch: { url: "https://Example.com/a?b=1", prompt: "Summarize the page" },
      chatKey: "s1",
      projectKey: "/repo",
    });
    respondClaudeApproval("s1", cards(events)[0].requestId, "allow");
    expect(await answer("r1")).toMatchObject({ behavior: "allow" });
    await finish(turn);
  });

  it("Always for example.com lets the next example.com fetch through; another host asks", async () => {
    const { events, turn } = await startTurn();
    ask("r1", "WebFetch", fetchUrl("https://example.com/one"));
    await waitFor(() => cards(events).length === 1, "first card");
    // What the card's "Always allow for this website" does, then its answer.
    rememberSiteRule("chat", "s1", "example.com", "always");
    respondClaudeApproval("s1", cards(events)[0].requestId, "allow");
    await answer("r1");
    ask("r2", "WebFetch", fetchUrl("https://EXAMPLE.com./two"));
    expect(await answer("r2")).toMatchObject({ behavior: "allow" });
    expect(cards(events)).toHaveLength(1);
    ask("r3", "WebFetch", fetchUrl("https://evil-example.com/"));
    await waitFor(() => cards(events).length === 2, "card for another host");
    expect(responseFor("r3")).toBeUndefined();
    respondClaudeApproval("s1", cards(events)[1].requestId, "deny");
    await answer("r3");
    await finish(turn);
  });

  it("a new chat asks again", async () => {
    rememberSiteRule("chat", "s1", "example.com", "always");
    const { events, turn } = await startTurn(undefined, { sessionId: "s2" });
    ask("r1", "WebFetch", fetchUrl("https://example.com/"));
    await waitFor(() => cards(events).length === 1, "card in the new chat");
    respondClaudeApproval("s2", cards(events)[0].requestId, "deny");
    await answer("r1");
    await finish(turn);
  });

  it("a Never rule wins, also over Always on the tool and in Full access", async () => {
    rememberSiteRule("chat", "s1", "example.com", "never");
    for (const runtimeMode of ["supervised", "full-access"] as const) {
      const { events, turn } = await startTurn(
        { always: ["WebFetch"] },
        { runtimeMode },
      );
      ask("r1", "WebFetch", fetchUrl("https://example.com/"));
      const result = await answer("r1");
      expect(result).toMatchObject({ behavior: "deny" });
      expect(String(result.message)).toContain("example.com");
      expect(cards(events)).toHaveLength(0);
      await finish(turn);
      await stopClaudeSession("s1");
      __claudeTestReset();
      sent.length = 0;
    }
  });

  it("Always on the WebFetch tool does not cover a new website", async () => {
    const { events, turn } = await startTurn({ always: ["WebFetch"] });
    ask("r1", "WebFetch", fetchUrl("https://new.example/"));
    await waitFor(() => cards(events).length === 1, "card");
    respondClaudeApproval("s1", cards(events)[0].requestId, "deny");
    await answer("r1");
    await finish(turn);
  });

  it("Full access does not ask", async () => {
    const { events, turn } = await startTurn(undefined, {
      runtimeMode: "full-access",
    });
    ask("r1", "WebFetch", fetchUrl("https://example.com/"));
    expect(await answer("r1")).toMatchObject({ behavior: "allow" });
    expect(cards(events)).toHaveLength(0);
    await finish(turn);
  });
});

describe("browser-use's plugin tools get the site card (5.16)", () => {
  const EXEC = "mcp__plugin_browser-use_browser-use__browser_exec";

  it("shows the code card, with no rule, even for a host allowed in this chat", async () => {
    rememberSiteRule("chat", "s1", "example.com", "always");
    const { events, turn } = await startTurn();
    ask("r1", EXEC, { code: "await page.goto('https://example.com')" });
    await waitFor(() => cards(events).length === 1, "card");
    expect(cards(events)[0].site).toMatchObject({
      server: "browser-use",
      host: "example.com",
      ruleable: false,
      code: true,
    });
    respondClaudeApproval("s1", cards(events)[0].requestId, "deny");
    await answer("r1");
    await finish(turn);
  });

  it("says when the call names no website", async () => {
    const { events, turn } = await startTurn();
    ask("r1", EXEC, { code: "return document.title" });
    await waitFor(() => cards(events).length === 1, "card");
    expect(cards(events)[0].site).toMatchObject({
      host: "(no website named)",
      hosts: [],
    });
    respondClaudeApproval("s1", cards(events)[0].requestId, "allow");
    await answer("r1");
    await finish(turn);
  });

  it("refuses code that names a blocked host", async () => {
    rememberSiteRule("chat", "s1", "blocked.example", "never");
    const { events, turn } = await startTurn();
    ask("r1", EXEC, { code: "await page.goto('https://blocked.example/x')" });
    expect(await answer("r1")).toMatchObject({ behavior: "deny" });
    expect(cards(events)).toHaveLength(0);
    await finish(turn);
  });
});
