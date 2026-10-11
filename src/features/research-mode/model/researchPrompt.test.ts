import { describe, expect, it } from "vitest";
import {
  researchDate,
  researchReportPath,
  researchSlug,
  researchTurnPrompt,
  sanitizeResearchRequest,
  type ResearchRequest,
} from "./researchPrompt";

const REQUEST: ResearchRequest = {
  reportPath: "research/2026-10-10-best-local-llm-runtimes.md",
  search: ["WebSearch", "the exa connector (web_search_exa)"],
  fetch: ["WebFetch", "the exa connector (web_fetch_exa)"],
  subagents: true,
};

describe("researchTurnPrompt", () => {
  const prompt = researchTurnPrompt(
    "  What are the best local LLM runtimes?  ",
    REQUEST,
  );

  it("names the chat's search and page tools", () => {
    expect(prompt).toContain(
      "Search tools in this chat: WebSearch and the exa connector (web_search_exa).",
    );
    expect(prompt).toContain(
      "Tools that open a page: WebFetch and the exa connector (web_fetch_exa).",
    );
  });

  it("asks for sub-questions, wide search, full reads and cross-checks", () => {
    expect(prompt).toMatch(/1\. Restate the question .* sub-questions/);
    expect(prompt).toContain("Search widely.");
    expect(prompt).toContain(
      "Open and read the best sources in full. Do not rely on search snippets.",
    );
    expect(prompt).toContain("Note where sources disagree");
  });

  it("asks for the report at the given path, with a short answer first and numbered sources", () => {
    expect(prompt).toContain(
      "Write the report to `research/2026-10-10-best-local-llm-runtimes.md` in the working folder.",
    );
    const layout = prompt.slice(prompt.indexOf("Report layout:"));
    expect(layout.indexOf("Short answer")).toBeLessThan(
      layout.indexOf("Findings"),
    );
    expect(layout).toContain(
      "`## Sources`: a numbered list, `[n] Title, URL`.",
    );
    expect(prompt).toContain("Cite sources inline as [n]");
    expect(prompt).toContain(
      "Then reply in chat with the short answer, the report's path and the three to five key sources",
    );
  });

  it("ends with the trimmed question", () => {
    expect(
      prompt.endsWith("## Question\n\nWhat are the best local LLM runtimes?"),
    ).toBe(true);
  });

  it("asks for subagents only when the harness has them", () => {
    expect(prompt).toContain("subagents (the Task or Agent tool)");
    const codex = researchTurnPrompt("q", { ...REQUEST, subagents: false });
    expect(codex).not.toContain("subagents");
  });

  it("says so when no tool opens a page", () => {
    const text = researchTurnPrompt("q", {
      ...REQUEST,
      search: ["the brave connector"],
      fetch: [],
    });
    expect(text).toContain("Search tools in this chat: the brave connector.");
    expect(text).not.toContain("Tools that open a page");
    expect(text).toContain("None of your tools opens a full page.");
  });

  it("uses no em or en dashes", () => {
    expect(prompt).not.toMatch(/[\u2013\u2014]/);
    expect(
      researchTurnPrompt("q", { ...REQUEST, fetch: [], subagents: false }),
    ).not.toMatch(/[\u2013\u2014]/);
  });

  it("numbers the steps without gaps", () => {
    const numbers = [...prompt.matchAll(/^(\d+)\. /gm)].map((m) =>
      Number(m[1]),
    );
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
  });
});

describe("research file names", () => {
  it("dates in local time", () => {
    expect(researchDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  it("slugs the first words of the question", () => {
    expect(researchSlug("What are the best local LLM runtimes in 2026?")).toBe(
      "what-are-the-best-local-llm-runtimes",
    );
    expect(researchSlug("Café prices: Zürich vs. São Paulo")).toBe(
      "cafe-prices-zurich-vs-sao-paulo",
    );
  });

  it("drops URLs and punctuation", () => {
    expect(researchSlug("Summarise https://example.com/a?b=c please!!")).toBe(
      "summarise-please",
    );
  });

  it("caps the slug length on a word boundary", () => {
    const slug = researchSlug(
      "internationalization localization accessibility interoperability documentation",
    );
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug).toBe("internationalization-localization-accessibility");
    expect(researchSlug("a".repeat(80))).toBe("a".repeat(48));
  });

  it("falls back for text with no Latin letters or digits", () => {
    expect(researchSlug("東京の天気")).toBe("research");
    expect(researchSlug("   ")).toBe("research");
  });

  it("builds the path under research/", () => {
    expect(
      researchReportPath("Why is the sky blue?", new Date(2026, 9, 10)),
    ).toBe("research/2026-10-10-why-is-the-sky-blue.md");
  });
});

describe("sanitizeResearchRequest", () => {
  it("keeps a well formed request", () => {
    expect(sanitizeResearchRequest(REQUEST)).toEqual(REQUEST);
  });

  it("rejects a path outside research/ or with no search tool", () => {
    expect(
      sanitizeResearchRequest({ ...REQUEST, reportPath: "../etc/passwd" }),
    ).toBeUndefined();
    expect(
      sanitizeResearchRequest({ ...REQUEST, reportPath: "/tmp/x.md" }),
    ).toBeUndefined();
    expect(sanitizeResearchRequest({ ...REQUEST, search: [] })).toBeUndefined();
    expect(sanitizeResearchRequest(null)).toBeUndefined();
    expect(sanitizeResearchRequest([REQUEST])).toBeUndefined();
  });

  it("bounds and cleans the tool labels", () => {
    const out = sanitizeResearchRequest({
      ...REQUEST,
      search: ["WebSearch", "WebSearch", 3, "  ", "x".repeat(500)],
      fetch: "WebFetch",
      subagents: "yes",
    });
    expect(out?.search).toEqual(["WebSearch", "x".repeat(120)]);
    expect(out?.fetch).toEqual([]);
    expect(out?.subagents).toBe(false);
  });
});
