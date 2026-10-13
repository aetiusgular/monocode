import { describe, expect, it } from "vitest";
import { applyHarnessEvents } from "../../../integrations/harness/core/apply";
import type { HarnessEvent } from "../../../integrations/harness/core/types";
import { newSession, type Block, type Session } from "../../sessions/model/session";
import { rewindOptions } from "./rewind";
import {
  applyChatRewind,
  cutChatTranscript,
  rewindChatInSessions,
  takeRewoundPrompt,
  type ChatSessionStore,
} from "./turnRewind";

const user = (id: string, providerTurnId: string): Block => ({
  id,
  role: "user",
  text: `prompt ${id}`,
  providerTurnId,
});
const reply = (id: string): Block => ({ id, role: "assistant", text: `reply ${id}` });

/** The tester's chat: three turns on Claude Code. */
function claudeChat(): Session {
  return {
    ...newSession("claude", "/repo"),
    id: "s1",
    providerSessionId: "sess_1",
    blocks: [
      user("u1", "claude-first-turn"),
      reply("a1"),
      user("u2", "uuid-end-of-turn-1"),
      reply("a2"),
      user("u3", "uuid-end-of-turn-2"),
      reply("a3"),
    ],
  };
}

/**
 * The app's chat store as App.tsx keeps it: React state, a ref copied from
 * state on each render, and a harness event queue whose flush rebuilds the
 * list from the ref and sets state to it (App.tsx, the HarnessEventQueue
 * apply callback). `setState` is queued until `render`, as React does.
 */
function appStore(initial: Session[]) {
  let state = initial;
  const ref = { current: initial };
  const pending: Array<Session[] | ((prev: Session[]) => Session[])> = [];
  const queued = new Map<string, HarnessEvent[]>();
  const setState = (update: Session[] | ((prev: Session[]) => Session[])) => {
    pending.push(update);
  };
  const flush = () => {
    if (queued.size === 0) return;
    const prev = ref.current;
    const next = prev.map((session) => {
      const events = queued.get(session.id);
      return events ? applyHarnessEvents(session, events) : session;
    });
    queued.clear();
    ref.current = next;
    setState(next);
  };
  return {
    ref,
    enqueue: (sessionId: string, event: HarnessEvent) => {
      const list = queued.get(sessionId) ?? [];
      list.push(event);
      queued.set(sessionId, list);
    },
    flush,
    render: () => {
      for (const update of pending.splice(0)) {
        state = typeof update === "function" ? update(state) : update;
      }
      ref.current = state;
      return state;
    },
    store: (): ChatSessionStore => ({
      flushEvents: flush,
      current: () => ref.current,
      replaceCurrent: (next) => {
        ref.current = next;
      },
      setState: (update) => setState(update),
    }),
    setState,
  };
}

/** What Claude Code's restart for a rewind queues (claude.ts, ensureLive). */
function restartEvents(app: ReturnType<typeof appStore>) {
  app.enqueue("s1", { type: "session.providerBound", providerSessionId: "sess_1" });
  app.enqueue("s1", { type: "session.started" });
}

describe("cutting the transcript after a Claude Code rewind", () => {
  it("reproduces the lost cut: a flush before React renders put turns 2 and 3 back", () => {
    // The code as it was: the cut went only through a React updater, and the
    // restart's events were still queued when the rewind settled.
    const app = appStore([claudeChat()]);
    restartEvents(app);
    const options = rewindOptions(app.ref.current[0], "u2")!;
    app.setState((prev) =>
      prev.map((session) =>
        session.id === "s1" ? applyChatRewind(session, options, "n-old") : session,
      ),
    );
    app.flush(); // the frame lands before React renders
    const [after] = app.render();
    expect(after.blocks.map((b) => b.id)).toEqual(["u1", "a1", "u2", "a2", "u3", "a3"]);
    expect(after.rewoundPrompt).toBeUndefined();
  });

  it("keeps the cut and the prompt when the restart's events flush before React renders", () => {
    const app = appStore([claudeChat()]);
    restartEvents(app);
    cutChatTranscript(app.store(), "s1", "u2", "n1");
    // A late frame, and a later event, both read the ref.
    app.enqueue("s1", { type: "session.started" });
    app.flush();
    const [after] = app.render();
    expect(after.blocks.map((b) => b.id)).toEqual(["u1", "a1"]);
    expect(after.rewoundPrompt).toEqual({
      text: "prompt u2",
      attachments: [],
      nonce: "n1",
    });
    expect(after.providerSessionId).toBe("sess_1");
  });

  it("keeps the cut when React renders first", () => {
    const app = appStore([claudeChat()]);
    restartEvents(app);
    cutChatTranscript(app.store(), "s1", "u2", "n2");
    const [rendered] = app.render();
    app.flush();
    const [after] = app.render();
    expect(rendered.blocks).toHaveLength(2);
    expect(after.blocks.map((b) => b.id)).toEqual(["u1", "a1"]);
  });

  it("cuts once and fills the composer once although ref and state both get the cut", () => {
    const app = appStore([claudeChat()]);
    cutChatTranscript(app.store(), "s1", "u2", "n3");
    const [after] = app.render();
    expect(after.blocks.map((b) => b.id)).toEqual(["u1", "a1"]);
    // The composer fills on the first sight of the nonce, never again.
    expect(takeRewoundPrompt(after.rewoundPrompt)).toBe(true);
    expect(takeRewoundPrompt(after.rewoundPrompt)).toBe(false);
    expect(takeRewoundPrompt({ ...after.rewoundPrompt! })).toBe(false);
  });

  it("leaves other chats and a chat whose prompt is gone as they are", () => {
    const other = { ...claudeChat(), id: "s2" };
    const list = [claudeChat(), other];
    const once = rewindChatInSessions(list, "s1", "u2", "n4");
    expect(once[1]).toBe(other);
    const twice = rewindChatInSessions(once, "s1", "u2", "n5");
    expect(twice[0]).toBe(once[0]);
    expect(twice[0].rewoundPrompt?.nonce).toBe("n4");
  });
});
