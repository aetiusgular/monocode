import { describe, expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import {
  CODE_BLOCK_MARKER,
  SPEECH_CHUNK_LENGTH,
  replySpeechSource,
  speechChunks,
  speechText,
} from "./speechText";

describe("what a reply sounds like", () => {
  it("reads headings, paragraphs and list items without their marks", () => {
    const text = speechText(
      [
        "## What changed",
        "",
        "The parser now **keeps** _trailing_ commas and",
        "reports ~~every~~ the first error.",
        "",
        "- First item",
        "- [x] Second item, done",
        "1. Third item",
        "2) Fourth item",
      ].join("\n"),
    );
    expect(text.split("\n")).toEqual([
      "What changed",
      "The parser now keeps trailing commas and reports every the first error.",
      "First item",
      "Second item, done",
      "Third item",
      "Fourth item",
    ]);
  });

  it("says a short marker in place of a fenced block", () => {
    const text = speechText(
      [
        "Run this:",
        "```ts",
        "const x: number = 1;",
        "if (x) { return `no`; }",
        "```",
        "Then check the log.",
      ].join("\n"),
    );
    expect(text.split("\n")).toEqual([
      "Run this:",
      CODE_BLOCK_MARKER,
      "Then check the log.",
    ]);
    expect(text).not.toContain("const");
  });

  it("treats a fence left open as code to the end, as it renders", () => {
    const text = speechText("Before\n\n~~~\nrm -rf build\nstill code");
    expect(text.split("\n")).toEqual(["Before", CODE_BLOCK_MARKER]);
  });

  it("does not close a fence on a shorter or different one inside it", () => {
    const text = speechText(
      ["````md", "```js", "let a;", "```", "~~~~", "````", "After"].join("\n"),
    );
    expect(text.split("\n")).toEqual([CODE_BLOCK_MARKER, "After"]);
  });

  it("reads a table's cells and never its pipes or rule", () => {
    const text = speechText(
      [
        "| File | Tests |",
        "| :--- | ---: |",
        "| `a.ts` | 12 |",
        "| b\\|c | 3 |",
      ].join("\n"),
    );
    expect(text.split("\n")).toEqual(["File, Tests", "a.ts, 12", "b|c, 3"]);
    expect(text).not.toContain("---");
  });

  it("drops rules, link targets, comments and tags", () => {
    const text = speechText(
      [
        "Above",
        "",
        "---",
        "",
        "<details><summary>More</summary>",
        "",
        "Inside <!-- not this --> the fold<br>",
        "",
        "</details>",
        "",
        "[1]: https://example.com/a/b",
      ].join("\n"),
    );
    expect(text.split("\n")).toEqual(["Above", "More", "Inside the fold"]);
  });

  it("keeps a link's words and does not spell out an address", () => {
    expect(
      speechText(
        "See [the guide](https://example.com/guide?x=1), ![a chart](c.png) and https://example.com/raw/path.",
      ),
    ).toBe("See the guide, a chart and link");
    expect(speechText("Mail <mailto:me@example.com> or [this][ref].")).toBe(
      "Mail link or this.",
    );
  });

  it("leaves names with underscores and code spans as written", () => {
    expect(
      speechText("Call `load_user_by_id(*args)` then set max_retry_count."),
    ).toBe("Call load_user_by_id(*args) then set max_retry_count.");
    expect(speechText("Use ``a `tick` b`` and 2 * 3 * 4.")).toBe(
      "Use a `tick` b and 2 * 3 * 4.",
    );
  });

  it("unwraps quotes, escapes and entities", () => {
    expect(speechText("> **Note**\n> Tom &amp; Jerry said \\*hi\\*")).toBe(
      "Note Tom and Jerry said *hi*",
    );
  });

  it("has nothing to say for marks alone", () => {
    expect(speechText("")).toBe("");
    expect(speechText("---\n\n***\n\n![](shot.png)")).toBe("");
  });
});

describe("which blocks of a turn are read", () => {
  it("takes the reply and a plan, not tools, reasoning or task lists", () => {
    const blocks: Block[] = [
      { id: "u", role: "user", text: "Fix it" },
      { id: "r", role: "reasoning", text: "Thinking about the fix" },
      { id: "t", role: "tool", text: "npm test" },
      { id: "a1", role: "assistant", text: "  Found the bug.  " },
      { id: "k", role: "tasks", text: "- [x] Fix" },
      { id: "p", role: "plan", text: "# Plan\n1. Ship" },
      { id: "a2", role: "assistant", text: "" },
      { id: "s", role: "system", text: "Notice" },
    ];
    expect(replySpeechSource(blocks)).toBe("Found the bug.\n\n# Plan\n1. Ship");
  });
});

describe("cutting speech into pieces the voice can finish", () => {
  it("keeps lines apart and sentences together while they fit", () => {
    expect(
      speechChunks("One. Two! Three?\nFour is in v1.2 of file.ts. Five.", 40),
    ).toEqual(["One. Two! Three?", "Four is in v1.2 of file.ts. Five."]);
  });

  it("starts a new piece when the next sentence would not fit", () => {
    const chunks = speechChunks(
      "The first sentence is here. The second sentence is here. Third.",
      30,
    );
    expect(chunks).toEqual([
      "The first sentence is here.",
      "The second sentence is here.",
      "Third.",
    ]);
  });

  it("cuts a long sentence at a comma, or else at a space", () => {
    const byComma = speechChunks(
      "alpha beta gamma delta, epsilon zeta eta theta iota kappa",
      30,
    );
    expect(byComma[0]).toBe("alpha beta gamma delta,");
    const bySpace = speechChunks(
      "alpha beta gamma delta epsilon zeta eta theta",
      20,
    );
    expect(bySpace).toEqual([
      "alpha beta gamma",
      "delta epsilon zeta",
      "eta theta",
    ]);
  });

  it("never returns a piece over the limit or drops a word", () => {
    const sentence =
      "This sentence keeps going with clause after clause, and more words, and it never quite ends";
    const text = Array.from({ length: 12 }, () => sentence).join(" ") + ".";
    const chunks = speechChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SPEECH_CHUNK_LENGTH);
      expect(chunk).toBe(chunk.trim());
    }
    expect(chunks.join(" ")).toBe(text);
  });

  it("breaks a word longer than the limit instead of looping", () => {
    expect(speechChunks("x".repeat(25), 10)).toEqual([
      "x".repeat(10),
      "x".repeat(10),
      "x".repeat(5),
    ]);
  });

  it("ends a sentence at CJK stops, which have no space after them", () => {
    expect(speechChunks("これは一つ目。これは二つ目。", 8)).toEqual([
      "これは一つ目。",
      "これは二つ目。",
    ]);
  });

  it("returns nothing for nothing", () => {
    expect(speechChunks("")).toEqual([]);
    expect(speechChunks("\n\n")).toEqual([]);
  });
});
