/**
 * Research mode: one message the agent answers by searching the web, reading
 * sources and writing a cited report into the working folder. The flag is per
 * message. The transcript shows the user's own words with a small label; only
 * the harness sees the instructions below.
 */

/** What a research message carries from the composer to the harness turn. */
export type ResearchRequest = {
  /** Report file, relative to the working folder, e.g. `research/2026-10-10-x.md`. */
  reportPath: string;
  /** Tools that search the web, as the instructions name them. */
  search: string[];
  /** Tools that open and read a page, as the instructions name them. */
  fetch: string[];
  /** Claude Code can split independent sub-questions across subagents. */
  subagents: boolean;
};

const MAX_TOOLS = 12;
const MAX_LABEL = 120;
const MAX_SLUG = 48;
const MAX_SLUG_WORDS = 7;
const REPORT_PATH = /^research\/\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,48}\.md$/;

/** `YYYY-MM-DD` in the user's own time zone. */
export function researchDate(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * A short file-name slug from the question: lowercase ASCII words joined by
 * hyphens. Text with no Latin letters or digits gives `research`.
 */
export function researchSlug(text: string): string {
  const words = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_SLUG_WORDS);
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > MAX_SLUG) break;
    slug = next;
  }
  if (!slug && words[0]) slug = words[0].slice(0, MAX_SLUG);
  return slug || "research";
}

/** Where the report goes, relative to the working folder. */
export function researchReportPath(text: string, now?: Date): string {
  return `research/${researchDate(now)}-${researchSlug(text)}.md`;
}

function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** The research instructions wrapped around the user's question. */
export function researchTurnPrompt(
  question: string,
  request: ResearchRequest,
): string {
  const steps = [
    "Restate the question in one sentence. List the sub-questions you need to answer.",
    "Search widely. Use several queries for each sub-question, and more than one search tool when you have them.",
    request.fetch.length > 0
      ? "Open and read the best sources in full. Do not rely on search snippets."
      : "None of your tools opens a full page. Read as much of each source as your search tool returns, and say in the report that you could not open pages.",
    "Prefer primary sources, official documentation and recent material. Give dates for facts that change over time.",
    "Cross-check each key claim against more than one source. Note where sources disagree and which one you trust more, and why.",
    ...(request.subagents
      ? [
          "When sub-questions are independent, research them in parallel with subagents (the Task or Agent tool), then merge what they find.",
        ]
      : []),
    `Write the report to \`${request.reportPath}\` in the working folder. Create the \`research\` folder if needed. If that file already exists, add -2, -3 and so on to the name.`,
    "Then reply in chat with the short answer, the report's path and the three to five key sources with their URLs.",
  ];
  return [
    "Research mode is on for this message. Research the question below and write a report.",
    "",
    `Search tools in this chat: ${joinLabels(request.search)}.`,
    ...(request.fetch.length > 0
      ? [`Tools that open a page: ${joinLabels(request.fetch)}.`]
      : []),
    "",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "Report layout:",
    "- A `#` title.",
    "- `## Short answer`: a few sentences that answer the question.",
    "- `## Findings`: one subsection per sub-question.",
    "- `## Disagreements and open questions`.",
    "- `## Sources`: a numbered list, `[n] Title, URL`.",
    "Cite sources inline as [n], numbered as in the Sources list.",
    "",
    "If a tool fails, say so and use another.",
    "",
    "## Question",
    "",
    question.trim(),
  ].join("\n");
}

function labels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (out.length >= MAX_TOOLS) break;
    if (typeof entry !== "string") continue;
    const label = entry.trim().slice(0, MAX_LABEL);
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

/** A request read back from disk, as a queued message keeps it. */
export function sanitizeResearchRequest(
  value: unknown,
): ResearchRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const reportPath =
    typeof record.reportPath === "string" ? record.reportPath : "";
  const search = labels(record.search);
  if (!REPORT_PATH.test(reportPath) || search.length === 0) return undefined;
  return {
    reportPath,
    search,
    fetch: labels(record.fetch),
    subagents: record.subagents === true,
  };
}
