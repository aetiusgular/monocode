import { beforeEach, describe, expect, it, vi } from "vitest";

const { provider } = vi.hoisted(() => ({
  provider: vi.fn((_id: string | undefined) => "unknown" as "local" | "hosted" | "unknown"),
}));
vi.mock("../../model-setup/model/providerLocality", () => ({ providerLocality: provider }));
vi.mock("../../gateway-connectors/model/sessionGateway", () => ({
  gatewaySessionInput: () => ({ servers: [], names: new Set(), defaultOff: [] }),
}));

import { parseReviewPatch, lineText } from "./reviewDiff";
import {
  chunkBudgetChars,
  reviewChunks,
  UNKNOWN_WINDOW,
  CHUNK_SHARE,
  CHARS_PER_TOKEN,
  PROMPT_OVERHEAD_CHARS,
} from "./reviewChunks";
import {
  checkFindings,
  formatFindingForChat,
  parseFindingLines,
} from "./findings";
import {
  buildReviewPrompt,
  reviewerLocality,
  runReview,
  sameRoute,
} from "./runReview";
import {
  forgetReviewConsent,
  recordReviewConsent,
  reviewConsented,
  reviewNeedsConsent,
} from "./reviewConsent";
import {
  registerHarness,
  type HarnessAdapter,
  type TextPromptInput,
} from "../../../integrations/harness/core/registry";
import { resetHarnessModelOverlays, setHarnessModels } from "../../sessions/model/models";
import { resetTraitOverridesCache } from "../../model-traits/model/modelTraits";

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 111..222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -10,4 +10,5 @@ function main() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = b / 0;",
  " return a;",
  "diff --git a/old.txt b/old.txt",
  "deleted file mode 100644",
  "--- a/old.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
  "diff --git a/new file.md b/new file.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new file.md",
  "@@ -0,0 +1,2 @@",
  "+# Title",
  "+Body",
  "",
].join("\n");

function mockLocalStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
      key: () => null,
      length: 0,
    },
    configurable: true,
  });
}

beforeEach(() => {
  mockLocalStorage();
  resetTraitOverridesCache();
  resetHarnessModelOverlays();
  provider.mockReset();
  provider.mockImplementation(() => "unknown");
});

describe("parseReviewPatch", () => {
  it("splits files and records the lines the diff shows", () => {
    const files = parseReviewPatch(PATCH);
    expect(files.map((file) => file.path)).toEqual(["src/app.ts", "old.txt", "new file.md"]);
    const app = files[0];
    expect([...app.shown].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
    expect([...app.added].sort((a, b) => a - b)).toEqual([11, 12]);
    expect(lineText(app, 12)).toBe("const c = b / 0;");
    expect(files[1].deleted).toBe(true);
    expect(files[1].shown.size).toBe(0);
    expect([...files[2].added]).toEqual([1, 2]);
  });

  it("returns nothing for an empty or junk patch", () => {
    expect(parseReviewPatch("")).toEqual([]);
    expect(parseReviewPatch("hello\nworld")).toEqual([]);
  });
});

describe("chunks (rule 5)", () => {
  it("budgets 40% of the window, and assumes 16k when unknown (case 1)", () => {
    const unknown = Math.floor(UNKNOWN_WINDOW * CHUNK_SHARE * CHARS_PER_TOKEN) - PROMPT_OVERHEAD_CHARS;
    expect(chunkBudgetChars(undefined)).toBe(unknown);
    expect(chunkBudgetChars(0)).toBe(unknown);
    expect(chunkBudgetChars(200_000)).toBe(
      Math.floor(200_000 * CHUNK_SHARE * CHARS_PER_TOKEN) - PROMPT_OVERHEAD_CHARS,
    );
    expect(chunkBudgetChars(1_000)).toBe(2_000);
  });

  it("packs whole files and splits a large file at hunks", () => {
    const files = parseReviewPatch(PATCH);
    expect(reviewChunks(files, 100_000)).toHaveLength(1);
    const big = [
      "diff --git a/big.ts b/big.ts",
      "--- a/big.ts",
      "+++ b/big.ts",
      "@@ -1,1 +1,1 @@",
      `+${"x".repeat(1_500)}`,
      "@@ -100,1 +100,1 @@",
      `+${"y".repeat(1_500)}`,
      "",
    ].join("\n");
    const chunks = reviewChunks(parseReviewPatch(big), 2_000);
    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expect(chunk.text.startsWith("diff --git a/big.ts")).toBe(true);
      expect(chunk.text.length).toBeLessThanOrEqual(2_100);
    }
  });

  it("cuts a single hunk larger than a chunk and says so", () => {
    const huge = [
      "diff --git a/huge.ts b/huge.ts",
      "--- a/huge.ts",
      "+++ b/huge.ts",
      "@@ -1,1 +1,1 @@",
      `+${"z".repeat(10_000)}`,
      "",
    ].join("\n");
    const [chunk] = reviewChunks(parseReviewPatch(huge), 2_000);
    expect(chunk.cut).toEqual(["huge.ts"]);
    expect(chunk.text).toContain("[cut to fit]");
    expect(chunk.text.length).toBeLessThanOrEqual(2_100);
    expect(buildReviewPrompt(chunk, 1, 1)).toContain("cut to fit and end early: huge.ts");
  });
});

describe("findings (rule 4)", () => {
  it("parses loose lines and ignores the rest", () => {
    const parsed = parseFindingLines(
      [
        "Here are my findings:",
        "src/app.ts:12: division by zero",
        "- `src/app.ts:11`: b changed from 2 to 3 without a reason",
        "* src/app.ts:12-13 - the divisor is constant",
        "1. new file.md: the title is a placeholder",
        "No findings.",
        "random sentence with a colon: here",
      ].join("\n"),
    );
    expect(parsed).toEqual([
      { path: "src/app.ts", line: 12, comment: "division by zero" },
      { path: "src/app.ts", line: 11, comment: "b changed from 2 to 3 without a reason" },
      { path: "src/app.ts", line: 12, comment: "the divisor is constant" },
      { path: "new file.md", line: null, comment: "the title is a placeholder" },
    ]);
  });

  it("checks every finding against the diff", () => {
    const files = parseReviewPatch(PATCH);
    const { kept, dropped } = checkFindings(
      [
        { path: "src/app.ts", line: 12, comment: "division by zero" },
        { path: "./src/app.ts", line: 500, comment: "line the diff does not show" },
        { path: "b/new file.md", line: 1, comment: "placeholder title" },
        { path: "app.ts", line: 10, comment: "short path" },
        { path: "nowhere.ts", line: 1, comment: "invented file" },
        { path: "src/app.ts", line: 12, comment: "division by zero" },
      ],
      files,
    );
    expect(dropped).toBe(1);
    expect(kept).toEqual([
      { path: "src/app.ts", line: 12, comment: "division by zero", quote: "const c = b / 0;" },
      { path: "src/app.ts", line: null, comment: "line the diff does not show", movedToFile: true },
      { path: "new file.md", line: 1, comment: "placeholder title", quote: "# Title" },
      { path: "src/app.ts", line: 10, comment: "short path", quote: "const a = 1;" },
    ]);
  });

  it("formats a finding for the chat", () => {
    expect(
      formatFindingForChat({ path: "a`b.ts", line: 3, comment: "fix", quote: "x" }),
    ).toBe("Review comment on `a\\`b.ts:3`:\n\n> x\n\nfix");
    expect(formatFindingForChat({ path: "a.ts", line: null, comment: "fix" })).toBe(
      "Review comment on `a.ts`:\n\nfix",
    );
  });
});

describe("runReview", () => {
  let prompts: TextPromptInput[] = [];
  let reply: (input: TextPromptInput) => Promise<string>;
  const adapter = (id: "codex" | "claude" | "fx", text = true) =>
    ({
      id,
      live: true,
      sendTurn: async () => {},
      steerTurn: async () => {},
      cancelTurn: async () => {},
      respondApproval: () => {},
      stopSession: async () => {},
      ...(text
        ? {
            runTextPrompt: async (input: TextPromptInput) => {
              prompts.push(input);
              return reply(input);
            },
          }
        : {}),
    }) as HarnessAdapter;

  beforeEach(() => {
    prompts = [];
    reply = async () => "src/app.ts:12: division by zero\nnowhere.ts:1: invented";
    registerHarness(adapter("codex"));
    registerHarness(adapter("claude"));
    registerHarness(adapter("fx", false));
  });

  const local = {
    kind: "route" as const,
    harness: "codex" as const,
    providerAccountId: "local",
    modelId: "codex:qwen2.5:7b",
    modelProvider: "ollama_local",
  };

  it("reviews on the reviewer's own route and keeps checked findings", async () => {
    setHarnessModels("codex", [
      { id: "codex:qwen2.5:7b", harness: "codex", name: "qwen", nativeId: "qwen2.5:7b", contextWindow: 16_384 },
    ]);
    const progress: number[] = [];
    const result = await runReview({
      cwd: "/repo",
      reviewer: local,
      loadPatch: async () => ({ patch: PATCH, truncated: false, skipped: [] }),
      onProgress: ({ done }) => progress.push(done),
    });
    expect(result.findings).toEqual([
      { path: "src/app.ts", line: 12, comment: "division by zero", quote: "const c = b / 0;" },
    ]);
    expect(result.dropped).toBe(1);
    expect(result.files).toBe(3);
    expect(progress).toEqual([0, 1]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ providerAccountId: "local", model: "qwen2.5:7b" });
    expect(prompts[0].prompt).toContain("const c = b / 0;");
  });

  it("splits a large diff for a small window and keeps going when a chunk fails (case 2)", async () => {
    setHarnessModels("codex", [
      { id: "codex:qwen2.5:7b", harness: "codex", name: "qwen", nativeId: "qwen2.5:7b", contextWindow: 2_000 },
    ]);
    const files = Array.from({ length: 3 }, (_, index) =>
      [
        `diff --git a/f${index}.ts b/f${index}.ts`,
        `--- a/f${index}.ts`,
        `+++ b/f${index}.ts`,
        "@@ -1,1 +1,1 @@",
        `+${"q".repeat(1_500)}`,
      ].join("\n"),
    ).join("\n");
    let call = 0;
    reply = async () => {
      call += 1;
      if (call === 2) throw new Error("no answer");
      return "";
    };
    const result = await runReview({
      cwd: "/repo",
      reviewer: local,
      loadPatch: async () => ({ patch: `${files}\n`, truncated: false, skipped: [] }),
    });
    expect(result.chunks).toBe(3);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("f1.ts: no answer");
    expect(result.findings).toEqual([]);
  });

  it("returns no findings and makes no call for a clean tree", async () => {
    const result = await runReview({
      cwd: "/repo",
      reviewer: local,
      loadPatch: async () => ({ patch: "", truncated: false, skipped: [] }),
    });
    expect(result.files).toBe(0);
    expect(prompts).toHaveLength(0);
  });

  it("refuses a reviewer whose harness has no side prompt (case 11)", async () => {
    await expect(
      runReview({
        cwd: "/repo",
        reviewer: "fx",
        loadPatch: async () => ({ patch: PATCH, truncated: false, skipped: [] }),
      }),
    ).rejects.toThrow(/cannot run a review/);
    expect(prompts).toHaveLength(0);
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runReview({
        cwd: "/repo",
        reviewer: local,
        signal: controller.signal,
        loadPatch: async () => ({ patch: PATCH, truncated: false, skipped: [] }),
      }),
    ).rejects.toThrow();
    expect(prompts).toHaveLength(0);
  });
});

describe("reviewer privacy (case 7)", () => {
  const owner = {
    kind: "route" as const,
    harness: "codex" as const,
    providerAccountId: "local",
    modelId: "codex:qwen2.5:7b",
    modelProvider: "ollama_local",
  };

  it("calls Claude Code hosted and a local provider local", () => {
    expect(reviewerLocality("claude")).toBe("hosted");
    provider.mockImplementation(() => "local");
    expect(reviewerLocality(owner)).toBe("local");
  });

  it("does not ask when the reviewer is the session's own route", () => {
    expect(reviewNeedsConsent({ project: "/repo", owner, reviewer: { ...owner } })).toBe(false);
    expect(sameRoute(owner, { ...owner, modelId: "codex:other" })).toBe(false);
  });

  it("does not ask for a local reviewer", () => {
    provider.mockImplementation(() => "local");
    expect(reviewNeedsConsent({ project: "/repo", owner, reviewer: { ...owner, modelId: "codex:other" } })).toBe(false);
  });

  it("asks once per project before the diff goes to a hosted reviewer", () => {
    expect(reviewNeedsConsent({ project: "/repo", owner, reviewer: "claude" })).toBe(true);
    expect(reviewNeedsConsent({ project: "/repo", owner: undefined, reviewer: "claude" })).toBe(true);
    recordReviewConsent("/repo/");
    expect(reviewConsented("/repo")).toBe(true);
    expect(reviewNeedsConsent({ project: "/repo", owner, reviewer: "claude" })).toBe(false);
    expect(reviewNeedsConsent({ project: "/other", owner, reviewer: "claude" })).toBe(true);
    forgetReviewConsent("/repo");
    expect(reviewConsented("/repo")).toBe(false);
  });

  it("treats an unknown reviewer as hosted", () => {
    expect(reviewNeedsConsent({ project: "/repo", owner, reviewer: "codex" })).toBe(true);
  });
});
