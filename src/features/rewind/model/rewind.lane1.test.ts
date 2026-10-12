import { describe, expect, it, vi } from "vitest";
import { newSession, type Block, type Session } from "../../sessions/model/session";
import {
  forkBlocks,
  forkTitle,
  rewindOptions,
  turnStartIndex,
} from "./rewind";
import { forkSessionAt } from "./forkSession";
import {
  applyChatRewind,
  takeRewoundPrompt,
  turnRewindFor,
} from "./turnRewind";

const user = (id: string, patch: Partial<Block> = {}): Block => ({
  id,
  role: "user",
  text: `prompt ${id}`,
  ...patch,
});
const reply = (id: string): Block => ({ id, role: "assistant", text: `reply ${id}` });

/** Three turns: u1, u2 (with a steered follow-up on Codex), u3. */
function chat(harness: Session["harness"], patch: Partial<Session> = {}): Session {
  return {
    ...newSession(harness, "/repo"),
    providerSessionId: "conv_1",
    title: "Fix the parser",
    blocks: [
      user("u1", { providerTurnId: "p1", checkpointTurnId: "cp1" }),
      reply("a1"),
      user("u2", { providerTurnId: "p2", checkpointTurnId: "cp2" }),
      user("u2b", { providerTurnId: "p2" }),
      reply("a2"),
      user("u3", { providerTurnId: "p3", checkpointTurnId: "cp3" }),
      reply("a3"),
    ],
    ...patch,
  };
}

describe("turnStartIndex", () => {
  it("joins follow-ups steered into the same provider turn", () => {
    const { blocks } = chat("codex");
    expect(turnStartIndex(blocks, 3)).toBe(2);
    expect(turnStartIndex(blocks, 2)).toBe(2);
    expect(turnStartIndex(blocks, 0)).toBe(0);
  });
});

describe("rewindOptions: chat", () => {
  it("offers any earlier turn on a harness that rewinds any turn", () => {
    for (const harness of ["claude", "codex"] as const) {
      const options = rewindOptions(chat(harness), "u2")!;
      expect(options.chat).toEqual({ enabled: true, providerTurnId: "p2" });
      expect(options).toMatchObject({ turnStart: 2, turnEnd: 5, laterPrompts: 1 });
    }
  });

  it("maps a steered follow-up to its turn's start", () => {
    const options = rewindOptions(chat("codex"), "u2b")!;
    expect(options.turnStart).toBe(2);
    expect(options.chat.providerTurnId).toBe("p2");
  });

  it("is off with a reason on a harness that cannot rewind (corner case 11)", () => {
    const options = rewindOptions(chat("cursor"), "u1")!;
    expect(options.chat.enabled).toBe(false);
    expect(options.chat.reason).toContain("cannot take back");
  });

  it("offers only the last turn on a last-turn harness", () => {
    // OpenCode rewinds only its last turn in the capability table.
    const session = chat("opencode");
    expect(rewindOptions(session, "u1")!.chat.reason).toContain("only its last turn");
    expect(rewindOptions(session, "u3")!.chat.enabled).toBe(true);
  });

  it("needs a recorded boundary on Claude Code and Codex (corner case 14)", () => {
    const session = chat("claude");
    session.blocks[0] = user("u1", { checkpointTurnId: "cp1" });
    const options = rewindOptions(session, "u1")!;
    expect(options.chat.enabled).toBe(false);
    expect(options.chat.reason).toContain("restart or a compaction");
  });

  it("is off while the chat is busy, asking or has queued messages (corner case 16)", () => {
    expect(rewindOptions(chat("claude", { busy: true }), "u1")!.chat.reason).toContain(
      "Stop the current turn",
    );
    expect(
      rewindOptions(
        chat("claude", {
          pendingQuestion: { requestId: 1, questions: [] } as unknown as Session["pendingQuestion"],
        }),
        "u1",
      )!.chat.reason,
    ).toContain("question");
    expect(
      rewindOptions(
        chat("claude", {
          queuedMessages: [{ id: "q", text: "later", attachments: [] }],
        }),
        "u1",
      )!.chat.reason,
    ).toContain("queued");
  });

  it("is off when the chat moved to another provider after the turn", () => {
    const session = chat("claude");
    session.blocks.splice(4, 0, { id: "h", role: "handoff", text: "" } as Block);
    expect(rewindOptions(session, "u1")!.chat.reason).toContain("another provider");
  });

  it("returns null for anything but a sent prompt", () => {
    const session = chat("claude", {
      blocks: [
        ...chat("claude").blocks,
        user("draft", { draft: true }),
        user("auto", { internal: true }),
      ],
    });
    expect(rewindOptions(session, "a1")).toBeNull();
    expect(rewindOptions(session, "draft")).toBeNull();
    expect(rewindOptions(session, "auto")).toBeNull();
    expect(rewindOptions(session, "missing")).toBeNull();
  });
});

describe("rewindOptions: files", () => {
  it("needs the turn's checkpoint and a folder no other busy chat shares", () => {
    expect(rewindOptions(chat("grok"), "u2")!.files).toEqual({
      enabled: true,
      checkpointTurnId: "cp2",
    });
    expect(
      rewindOptions(chat("grok"), "u2", { sharedCheckout: true })!.files.reason,
    ).toContain("Another chat");
    const old = chat("grok");
    old.blocks[0] = user("u1");
    expect(rewindOptions(old, "u1")!.files.reason).toContain("No checkpoint");
  });

  it("works on every harness, even one with no rewind (corner case 11)", () => {
    expect(rewindOptions(chat("cursor"), "u1")!.files.enabled).toBe(true);
  });
});

describe("rewindOptions: fork plan", () => {
  it("cuts Codex inclusively at the turn's own id", () => {
    expect(rewindOptions(chat("codex"), "u1")!.fork.plan).toEqual({
      mode: "native",
      harness: "codex",
      lastTurnId: "p1",
    });
    expect(rewindOptions(chat("codex"), "u3")!.fork.plan).toEqual({
      mode: "native",
      harness: "codex",
    });
  });

  it("cuts Claude at the entry the next prompt followed", () => {
    expect(rewindOptions(chat("claude"), "u1")!.fork.plan).toEqual({
      mode: "native",
      harness: "claude",
      at: "p2",
    });
    expect(rewindOptions(chat("claude"), "u3")!.fork.plan).toEqual({
      mode: "native",
      harness: "claude",
    });
  });

  it("falls back to approximate without what the native call needs", () => {
    expect(rewindOptions(chat("grok"), "u1")!.fork.plan.mode).toBe("approximate");
    expect(
      rewindOptions(chat("claude", { providerSessionId: undefined }), "u1")!.fork.plan,
    ).toMatchObject({ mode: "approximate", reason: expect.stringContaining("no conversation") });
    const lost = chat("claude");
    lost.blocks[2] = user("u2", { checkpointTurnId: "cp2" });
    expect(rewindOptions(lost, "u1")!.fork.plan.mode).toBe("approximate");
  });
});

describe("forkBlocks and forkTitle", () => {
  it("copies the transcript through the turn with new ids and no source ids", () => {
    let n = 0;
    const blocks = forkBlocks(chat("claude"), 5, () => `new${++n}`);
    expect(blocks.map((block) => block.id)).toEqual([
      "new1",
      "new2",
      "new3",
      "new4",
      "new5",
    ]);
    expect(blocks.map((block) => block.text)).toEqual([
      "prompt u1",
      "reply a1",
      "prompt u2",
      "prompt u2b",
      "reply a2",
    ]);
    expect(blocks.some((block) => block.providerTurnId || block.checkpointTurnId)).toBe(
      false,
    );
  });

  it("drops undecided approvals and drafts but keeps decided ones", () => {
    const session = chat("claude", {
      blocks: [
        user("u1"),
        { id: "ap1", role: "approval", text: "Run rm", approval: { requestId: 1 } } as Block,
        {
          id: "ap2",
          role: "approval",
          text: "Run ls",
          approval: { requestId: 2, decided: "allow" },
        } as Block,
        user("d", { draft: true }),
      ],
    });
    expect(forkBlocks(session, 4).map((block) => block.text)).toEqual([
      "prompt u1",
      "Run ls",
    ]);
  });

  it("marks the title", () => {
    expect(forkTitle("Fix it", false)).toBe("Fix it (fork)");
    expect(forkTitle("", true)).toBe("Chat (fork, approximate)");
  });
});

describe("forkSessionAt", () => {
  const sourceInput = {
    sessionId: "src",
    cwd: "/repo",
    model: "codex:gpt-5.4",
    runtimeMode: "supervised" as const,
    onEvent: () => undefined,
  };

  it("binds a native Codex fork to the new thread", async () => {
    const source = chat("codex");
    const nativeFork = vi.fn(async () => ({ providerSessionId: "thr_2" }));
    const result = await forkSessionAt({
      source,
      options: rewindOptions(source, "u1")!,
      base: newSession("codex", "/repo"),
      sourceInput,
      nativeFork,
    });
    expect(nativeFork).toHaveBeenCalledWith(
      expect.objectContaining({ providerSessionId: "conv_1", boundary: "p1" }),
    );
    expect(result.approximate).toBe(false);
    expect(result.session.providerSessionId).toBe("thr_2");
    expect(result.session.title).toBe("Fix the parser (fork)");
    expect(result.session.blocks).toHaveLength(2);
  });

  it("leaves a native Claude fork unbound until Claude names the copy", async () => {
    const source = chat("claude");
    const result = await forkSessionAt({
      source,
      options: rewindOptions(source, "u1")!,
      base: newSession("claude", "/repo"),
      sourceInput,
      nativeFork: async () => ({}),
    });
    expect(result.approximate).toBe(false);
    expect(result.session.providerSessionId).toBeUndefined();
  });

  it("falls back to an approximate fork seeded by a handoff when native fails", async () => {
    const source = chat("codex");
    const result = await forkSessionAt({
      source,
      options: rewindOptions(source, "u1")!,
      base: newSession("codex", "/repo"),
      sourceInput,
      nativeFork: async () => {
        throw new Error("thread is not paginated");
      },
    });
    expect(result.approximate).toBe(true);
    expect(result.reason).toContain("not paginated");
    expect(result.session.providerSessionId).toBeUndefined();
    expect(result.session.title).toContain("approximate");
    const roles = result.session.blocks.map((block) => block.role);
    expect(roles.slice(-2)).toEqual(["system", "handoff"]);
    const handoff = result.session.blocks.at(-1)!;
    expect(handoff.handoff).toMatchObject({ status: "ready", pending: true });
    // The recap covers the kept turn only.
    expect(handoff.text).not.toContain("prompt u3");
  });

  it("never changes the source chat", async () => {
    const source = chat("grok");
    const before = JSON.stringify(source);
    await forkSessionAt({
      source,
      options: rewindOptions(source, "u2")!,
      base: newSession("grok", "/repo"),
      sourceInput,
      nativeFork: async () => ({}),
    });
    expect(JSON.stringify(source)).toBe(before);
  });
});

describe("applyChatRewind and the rewound prompt", () => {
  it("cuts the transcript before the turn and keeps the prompt for the composer", () => {
    const session = chat("claude");
    session.blocks[2] = {
      ...session.blocks[2],
      attachments: [{ id: "f1", name: "a.png", kind: "image" } as never],
    };
    const next = applyChatRewind(session, rewindOptions(session, "u2b")!, "n1");
    expect(next.blocks.map((block) => block.id)).toEqual(["u1", "a1"]);
    expect(next.rewoundPrompt).toEqual({
      text: "prompt u2",
      attachments: [expect.objectContaining({ id: "f1" })],
      nonce: "n1",
    });
  });

  it("hands a rewound prompt to the composer once", () => {
    const prompt = { text: "x", attachments: [], nonce: `n-${Math.random()}` };
    expect(takeRewoundPrompt(prompt)).toBe(true);
    expect(takeRewoundPrompt(prompt)).toBe(false);
    expect(takeRewoundPrompt(undefined)).toBe(false);
  });
});

describe("turnRewindFor", () => {
  it("turns off an action the host did not wire, with a reason", () => {
    const rewind = turnRewindFor(chat("claude"), {}, "/repo", {});
    const options = rewind.optionsFor("u1")!;
    expect(options.chat).toEqual({ enabled: false, reason: "Not available here" });
    expect(options.fork.enabled).toBe(false);
    expect(options.files.enabled).toBe(true);
  });

  it("passes the session id to the host's actions", async () => {
    const onRewindChat = vi.fn(async () => undefined);
    const onFork = vi.fn(async () => undefined);
    const session = chat("claude");
    const rewind = turnRewindFor(session, {}, "/repo", {
      onRewindChat,
      onFork,
    });
    await rewind.onRewindChat("u2");
    await rewind.onFork("u1");
    expect(onRewindChat).toHaveBeenCalledWith(session.id, "u2");
    expect(onFork).toHaveBeenCalledWith(session.id, "u1");
  });
});
