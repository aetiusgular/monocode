import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    const key = `${args.project ?? ""}:${args.file}`;
    if (command === "project_context_read") {
      const text = store.get(key) ?? null;
      return { text, hash: `h:${text ?? ""}` };
    }
    if (command === "project_context_save") {
      const current = store.get(key) ?? "";
      if (args.expectedHash != null && args.expectedHash !== `h:${current}`)
        throw "conflict";
      store.set(key, String(args.text));
      return `h:${args.text}`;
    }
    throw new Error(command);
  }),
}));

import { MEMORY_MAX_LINES } from "../../monos/model/monoFiles";
import {
  addProjectMemory,
  lineAt,
  localOnlyCount,
  memoryEntries,
  memoryPart,
  removeEntryAt,
  replaceProjectMemory,
  searchProjectMemory,
  setEntryLocal,
} from "./projectMemory";
import {
  acceptProposal,
  loadProposals,
  parseProposals,
  propose,
  PROPOSALS_MAX,
  rejectProposal,
} from "./proposals";
import { handleProjectMemory } from "./agentMemory";
import { rememberableText, rememberText } from "./remember";

const project = "/code/app";
const now = new Date(2026, 9, 11);
const memory = () => store.get(`${project}:MEMORY.md`) ?? "";

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

beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
});

describe("#36: project memory entries", () => {
  it("adds dated entries once, with a local mark when asked", async () => {
    expect(
      (await addProjectMemory(project, "Tests use vitest", { now })).added,
    ).toBe(true);
    expect(
      (await addProjectMemory(project, "Tests use vitest", { now })).added,
    ).toBe(false);
    await addProjectMemory(project, "The client is United", {
      now,
      local: true,
    });
    expect(memory()).toBe(
      "- 2026-10-11 · Tests use vitest\n- 2026-10-11 · [local] The client is United\n",
    );
    const entries = memoryEntries(memory());
    expect(entries.map((entry) => [entry.text, entry.local])).toEqual([
      ["Tests use vitest", false],
      ["The client is United", true],
    ]);
    expect(localOnlyCount(memory())).toBe(1);
  });

  it("redacts secrets like Mono memory does (security item 1)", async () => {
    await addProjectMemory(
      project,
      "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      { now },
    );
    expect(memory()).not.toContain(
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    );
  });

  it("moves the oldest entries to the archive past the budget", async () => {
    for (let index = 0; index <= MEMORY_MAX_LINES; index++)
      await addProjectMemory(project, `fact ${index}`, { now });
    expect(memoryEntries(memory()).length).toBe(MEMORY_MAX_LINES);
    expect(store.get(`${project}:archive.md`)).toContain("fact 0");
  });

  it("supersedes, removes and toggles local by line", async () => {
    await addProjectMemory(project, "Deploys go through staging", { now });
    await replaceProjectMemory(
      project,
      "staging",
      "Deploys go straight to prod",
      { now },
    );
    expect(memory()).toContain("~~");
    expect(
      memoryEntries(memory())
        .filter((entry) => !entry.struck)
        .map((e) => e.text),
    ).toEqual(["Deploys go straight to prod"]);
    const live = memoryEntries(memory()).find((entry) => !entry.struck)!;
    const line = lineAt(memory(), live.index);
    expect(await setEntryLocal(project, live.index, line, true)).toBe(true);
    expect(memory()).toContain("[local] Deploys go straight to prod");
    // A stale line is refused, as when another window moved it.
    expect(await removeEntryAt(project, live.index, line)).toBe(false);
    const fresh = lineAt(memory(), live.index);
    expect(await setEntryLocal(project, live.index, fresh, false)).toBe(true);
    expect(memory()).not.toContain("[local] Deploys");
    expect(
      await removeEntryAt(project, live.index, lineAt(memory(), live.index)),
    ).toBe(true);
    expect(memory()).not.toContain("straight to prod");
  });

  it("searches memory and the archive", async () => {
    await addProjectMemory(project, "Releases are tagged on Fridays", { now });
    const hits = await searchProjectMemory(project, "release tags");
    expect(hits[0]?.line).toContain("Fridays");
  });
});

describe("#36: memory in the preamble", () => {
  const text =
    "# Memory\n- 2026-01-01 · old fact\n- ~~2026-02-01 · gone~~ · superseded 2026-03-01\n- 2026-03-01 · expires · until 2026-04-01\n- 2026-05-01 · [local] secret project\n- hand written line\n";
  it("keeps live, unexpired entries, oldest first, and local ones only when local", () => {
    const hosted = memoryPart(text, { local: false, today: "2026-10-11" });
    expect(hosted?.lines).toEqual([
      "- 2026-01-01 · old fact",
      "- hand written line",
    ]);
    const local = memoryPart(text, { local: true, today: "2026-10-11" });
    expect(local?.lines).toContain("- 2026-05-01 · secret project");
    expect(
      memoryPart("", { local: true, today: "2026-10-11" }),
    ).toBeUndefined();
  });
});

describe("#36: proposals", () => {
  it("are stored, deduplicated, capped, and accepted or dismissed", async () => {
    const [first] = await propose(project, [
      { fact: "Uses pnpm", local: false, source: "agent", sessionId: "s1" },
    ]);
    expect(
      await propose(project, [
        { fact: "Uses pnpm", local: false, source: "agent" },
      ]),
    ).toEqual([]);
    expect((await loadProposals(project)).length).toBe(1);
    expect(await acceptProposal(project, first.id)).toBe(true);
    expect(memory()).toContain("Uses pnpm");
    expect(await loadProposals(project)).toEqual([]);
    expect(await acceptProposal(project, first.id)).toBe(false);
    const [second] = await propose(project, [
      { fact: "x", local: true, source: "suggested" },
    ]);
    await rejectProposal(project, second.id);
    expect(await loadProposals(project)).toEqual([]);
    await propose(
      project,
      Array.from({ length: PROPOSALS_MAX + 5 }, (_, index) => ({
        fact: `f${index}`,
        local: false,
        source: "agent" as const,
      })),
    );
    expect((await loadProposals(project)).length).toBe(PROPOSALS_MAX);
  });

  it("drops malformed stored proposals", () => {
    expect(parseProposals("not json")).toEqual([]);
    expect(parseProposals('{"a":1}')).toEqual([]);
    expect(
      parseProposals(
        JSON.stringify([{ id: "a" }, { id: "b", fact: "ok", until: "bad" }, 5]),
      ),
    ).toEqual([{ id: "b", fact: "ok", local: false, source: "agent", at: 0 }]);
  });

  it("a replacing proposal supersedes the old entry when accepted", async () => {
    await addProjectMemory(project, "Node 20", { now });
    const [proposal] = await propose(project, [
      { fact: "Node 22", local: false, source: "agent", replaces: "Node 20" },
    ]);
    await acceptProposal(project, proposal.id);
    expect(
      memoryEntries(memory())
        .filter((e) => !e.struck)
        .map((e) => e.text),
    ).toEqual(["Node 22"]);
  });
});

describe("#36: app actions in a regular session", () => {
  const session = { id: "s1", cwd: project, harness: "claude" as const };

  it("proposes instead of writing, and answers at once", async () => {
    const result = (await handleProjectMemory(
      session,
      "memory.add",
      { fact: "CI runs on push" },
      now,
    )) as { proposed: string };
    expect(result.proposed).toBe("CI runs on push");
    expect(memory()).toBe("");
    expect((await loadProposals(project))[0]).toMatchObject({
      fact: "CI runs on push",
      source: "agent",
      sessionId: "s1",
      local: false,
    });
  });

  it("reads and searches without local-only entries for a hosted session (corner case 7)", async () => {
    await addProjectMemory(project, "Public fact about builds", { now });
    await addProjectMemory(project, "Private build fact", { now, local: true });
    const read = (await handleProjectMemory(
      session,
      "memory.read",
      {},
      now,
    )) as {
      entries: { fact: string }[];
    };
    expect(read.entries.map((entry) => entry.fact)).toEqual([
      "Public fact about builds",
    ]);
    const found = (await handleProjectMemory(
      session,
      "memory.search",
      { query: "build fact" },
      now,
    )) as { hits: { line: string }[] };
    expect(found.hits.map((hit) => hit.line).join()).not.toContain("Private");
  });

  it("refuses remove, topics, a chat with memory off, and no project", async () => {
    await expect(
      handleProjectMemory(session, "memory.remove", { find: "x" }),
    ).rejects.toThrow("Only the user");
    await expect(
      handleProjectMemory(session, "memory.read", { topic: "x" }),
    ).rejects.toThrow("no topic files");
    await expect(
      handleProjectMemory({ ...session, cwd: "~" }, "memory.read", {}),
    ).rejects.toThrow("no project");
    const { setChatMemoryOff } =
      await import("../../session-preamble/model/chatContext");
    setChatMemoryOff("s1", true);
    await expect(
      handleProjectMemory(session, "memory.read", {}),
    ).rejects.toThrow("switched off");
  });

  it("validates fields", async () => {
    await expect(
      handleProjectMemory(session, "memory.add", {}),
    ).rejects.toThrow("fact");
    await expect(
      handleProjectMemory(session, "memory.add", { fact: "x", until: "soon" }),
    ).rejects.toThrow("until");
    await expect(
      handleProjectMemory(session, "memory.add", { fact: "x".repeat(2000) }),
    ).rejects.toThrow();
  });
});

describe("#36: Remember this", () => {
  it("saves a selection at once, and refuses one too long for an entry", async () => {
    await rememberText(project, "  The API\nlives in server/  ", {
      harness: "codex",
    });
    expect(memory()).toContain("The API lives in server/");
    // Mac 2.8: a long selection is refused whole, never cut.
    expect(() => rememberableText("x".repeat(5000))).toThrow("at most 980");
    await expect(
      rememberText("~", "x", { harness: "codex" }),
    ).rejects.toThrow();
    await expect(
      rememberText(project, "   ", { harness: "codex" }),
    ).rejects.toThrow();
  });
});
