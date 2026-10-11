import { beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import { canEditLastTurn } from "../../sessions/model/editLastTurn";
import { canSteerQueuedHead } from "../../sessions/model/messageQueue";
import type { ResearchRequest } from "./researchPrompt";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const { getSession, sanitizeSessionForPersist } =
  await import("../../sessions/data/sessionStore");

const REQUEST: ResearchRequest = {
  reportPath: "research/2026-10-10-zstd-maintainers.md",
  search: ["WebSearch"],
  fetch: ["WebFetch"],
  subagents: true,
};

function session(): Session {
  return {
    ...newSession("claude", "/repo"),
    id: "s1",
    blocks: [
      {
        id: "u1",
        role: "user",
        text: "Who maintains zstd?",
        research: true,
        providerTurnId: "turn-1",
      },
      { id: "a1", role: "assistant", text: "Short answer: ..." },
    ],
    queuedMessages: [
      {
        id: "q1",
        text: "And brotli?",
        attachments: [],
        research: REQUEST,
      },
    ],
  };
}

async function roundTrip(live: Session) {
  const saved = JSON.parse(JSON.stringify(sanitizeSessionForPersist(live)));
  invoke.mockImplementation((cmd: string) =>
    Promise.resolve(cmd === "session_get" ? saved : null),
  );
  return getSession("s1");
}

describe("research across a restart", () => {
  beforeEach(() => invoke.mockReset());

  it("keeps the label on the sent message and the request on a queued one", async () => {
    const loaded = await roundTrip(session());
    expect(loaded?.blocks[0]).toMatchObject({
      text: "Who maintains zstd?",
      research: true,
    });
    expect(loaded?.queuedMessages?.[0].research).toEqual(REQUEST);
  });

  it("drops a queued request whose report path is not under research/", async () => {
    const live = session();
    live.queuedMessages![0].research = {
      ...REQUEST,
      reportPath: "../outside.md",
    };
    const loaded = await roundTrip(live);
    expect(loaded?.queuedMessages?.[0]).not.toHaveProperty("research");
  });
});

describe("research turns in the queue and edit flows", () => {
  it("cannot be edited and resent, since the instructions are not in the text", () => {
    const live = session();
    live.queuedMessages = [];
    expect(canEditLastTurn(live)).toBe(false);
    live.blocks[0] = { ...live.blocks[0], research: undefined };
    expect(canEditLastTurn(live)).toBe(true);
  });

  it("waits for the running turn instead of steering it", () => {
    const busy: Session = { ...session(), busy: true, turnReady: true };
    expect(canSteerQueuedHead(busy)).toBe(false);
    busy.queuedMessages = [{ id: "q2", text: "plain", attachments: [] }];
    expect(canSteerQueuedHead(busy)).toBe(true);
  });
});
