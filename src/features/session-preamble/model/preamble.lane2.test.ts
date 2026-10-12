import { describe, expect, it } from "vitest";
import {
  buildPreamble,
  preambleBlock,
  preambleBudget,
  preambleHash,
  PREAMBLE_MAX_BYTES,
  withPreambleBlock,
  type PreamblePart,
} from "./preamble";

const instructions: PreamblePart = {
  id: "instructions",
  label: "Your instructions",
  text: "Use short declaratives.",
};

function memory(count: number, size = 60): PreamblePart {
  const lines = Array.from(
    { length: count },
    (_, index) =>
      `- 2026-10-${String((index % 28) + 1).padStart(2, "0")} · fact ${index} ${"x".repeat(size)}`,
  );
  return {
    id: "memory",
    label: "Project memory",
    text: lines.join("\n"),
    lines,
  };
}

describe("F2: preamble budget", () => {
  it("is 5% of the window at 4 characters a token, capped at 24 KB", () => {
    // Corner case 1: the local 7B at 16,384 tokens gets about 800 tokens.
    expect(preambleBudget(16_384)).toBe(3_276);
    expect(preambleBudget(200_000)).toBe(PREAMBLE_MAX_BYTES);
    expect(preambleBudget(1_000_000)).toBe(PREAMBLE_MAX_BYTES);
  });

  it("budgets an unknown window as the small local one", () => {
    expect(preambleBudget(undefined)).toBe(preambleBudget(16_384));
    expect(preambleBudget(0)).toBe(preambleBudget(16_384));
    expect(preambleBudget(Number.NaN)).toBe(preambleBudget(16_384));
  });
});

describe("F2: building the preamble", () => {
  it("keeps everything that fits and prints instructions first", () => {
    const built = buildPreamble([memory(2), instructions], 10_000);
    expect(built.included).toEqual(["instructions", "memory"]);
    expect(built.omitted).toEqual([]);
    expect(built.text.indexOf("<instructions>")).toBeLessThan(
      built.text.indexOf("<memory>"),
    );
    expect(built.chars).toBe(built.text.length);
    expect(built.overBudget).toBe(false);
  });

  it("cuts the oldest memory first and says how much (corner case 1)", () => {
    const built = buildPreamble(
      [instructions, memory(100)],
      preambleBudget(16_384),
    );
    expect(built.chars).toBeLessThanOrEqual(preambleBudget(16_384));
    expect(built.included).toContain("instructions");
    expect(built.included).toContain("memory");
    const cut = built.omitted.find((entry) => entry.id === "memory");
    expect(cut?.lines).toBeGreaterThan(0);
    // The newest entry stays, the oldest goes.
    expect(built.text).toContain("fact 99 ");
    expect(built.text).not.toContain("fact 0 ");
  });

  it("drops a whole part in cut order: memory, then notes, then instructions", () => {
    const notes: PreamblePart = {
      id: "project-notes",
      label: "Private project notes",
      text: "n".repeat(500),
    };
    const big: PreamblePart = { ...instructions, text: "i".repeat(400) };
    const built = buildPreamble([big, notes, memory(1, 300)], 480);
    expect(built.included).toEqual(["instructions"]);
    expect(built.omitted.map((entry) => entry.id)).toEqual([
      "memory",
      "project-notes",
    ]);
  });

  it("never cuts a required part, and reports when it is over budget", () => {
    const operator: PreamblePart = {
      id: "operator",
      label: "App access",
      text: "o".repeat(300),
      required: true,
    };
    const built = buildPreamble([instructions, operator], 100);
    expect(built.included).toContain("operator");
    expect(built.overBudget).toBe(true);
    expect(built.omitted.map((entry) => entry.id)).toEqual(["instructions"]);
  });

  it("leaves out empty parts and is empty with nothing to say", () => {
    const built = buildPreamble([{ ...instructions, text: "  " }], 1000);
    expect(built.text).toBe("");
    expect(built.included).toEqual([]);
  });

  it("hashes the text so a change is a new receipt", () => {
    const a = buildPreamble([instructions], 1000);
    const b = buildPreamble([{ ...instructions, text: "Other." }], 1000);
    expect(a.hash).toBe(buildPreamble([instructions], 1000).hash);
    expect(a.hash).not.toBe(b.hash);
    expect(preambleHash("")).toMatch(/^[0-9a-f]{8}:0$/);
  });
});

describe("F2: the message channel", () => {
  it("goes ahead of the message, after a slash command", () => {
    const block = preambleBlock("<instructions>\nx\n</instructions>");
    expect(block).toContain("<monocode_session_context>");
    expect(withPreambleBlock("hello", block, false)).toBe(`${block}\n\nhello`);
    expect(withPreambleBlock("/compact", block, true)).toBe(
      `/compact\n\n${block}`,
    );
    expect(withPreambleBlock("hello", "", false)).toBe("hello");
  });
});
