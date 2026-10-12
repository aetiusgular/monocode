import type { Block, HarnessId } from "../../sessions/model/session";

/** The fields of a session an export reads. */
export type ExportableSession = {
  title: string;
  harness: HarnessId;
  model: string;
  cwd: string;
  blocks: readonly Block[];
};

export type ExportOptions = {
  /** When the export was made. Injected so tests are stable. */
  now?: Date;
  /** Longest tool output kept per call, in characters. */
  maxToolDetail?: number;
};

const HARNESS_NAMES: Record<HarnessId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok Build",
  opencode: "OpenCode",
  pi: "Pi",
  omp: "omp",
  fx: "fx",
  hermes: "Hermes",
  antigravity: "Antigravity",
  devin: "Devin",
};

const DEFAULT_MAX_TOOL_DETAIL = 4000;

/**
 * A conversation as one Markdown file (#29): your messages and the replies,
 * the work of each turn folded under `<details>`, plans and task lists, and
 * the harness and model of each turn. It is also the stand-in for share links:
 * the file stays on your disk until you send it somewhere.
 *
 * Blocks MonoCode marks internal are left out, as the transcript leaves them
 * out. Tool output is cut to `maxToolDetail` characters per call.
 */
export function conversationToMarkdown(
  session: ExportableSession,
  options: ExportOptions = {},
): string {
  const now = options.now ?? new Date();
  const maxDetail = options.maxToolDetail ?? DEFAULT_MAX_TOOL_DETAIL;
  const out: string[] = [];
  out.push(`# ${oneLine(session.title) || "Untitled conversation"}`, "");
  out.push(`- Exported: ${now.toISOString()}`);
  out.push(`- Project: \`${oneLine(session.cwd).replace(/`/g, "'")}\``);
  out.push(
    `- Started on: ${HARNESS_NAMES[session.harness] ?? session.harness}, ${oneLine(session.model) || "default model"}`,
  );
  out.push("");

  let work: Block[] = [];
  const flushWork = () => {
    if (work.length === 0) return;
    out.push(...workSection(work, maxDetail), "");
    work = [];
  };

  for (const block of session.blocks) {
    if (block.internal || block.draft) continue;
    switch (block.role) {
      case "user": {
        flushWork();
        const when = block.sentAt ? ` · ${new Date(block.sentAt).toISOString()}` : "";
        out.push("---", "", `## You${when}`, "");
        out.push(block.text.trim() || "_(no text)_");
        const files = attachmentNames(block);
        if (files) out.push("", `Attached: ${files}`);
        out.push("");
        break;
      }
      case "assistant": {
        if (block.notice) {
          work.push(block);
          break;
        }
        flushWork();
        const by = block.turnModel
          ? `${HARNESS_NAMES[block.turnModel.harness] ?? block.turnModel.harness} · ${oneLine(block.turnModel.name)}`
          : "Assistant";
        out.push(`### ${by}`, "", block.text.trim(), "");
        break;
      }
      case "plan": {
        flushWork();
        const status = block.plan?.status ? ` (${block.plan.status})` : "";
        out.push(`### Plan${status}`, "", block.text.trim(), "");
        break;
      }
      case "tasks": {
        flushWork();
        out.push("### Tasks", "");
        const items = block.taskList?.items ?? [];
        if (items.length === 0) out.push(block.text.trim());
        for (const item of items) {
          const mark = item.status === "completed" ? "x" : " ";
          const note =
            item.status === "in_progress"
              ? " _(in progress)_"
              : item.status === "cancelled"
                ? " _(cancelled)_"
                : "";
          out.push(`- [${mark}] ${oneLine(item.text)}${note}`);
        }
        out.push("");
        break;
      }
      default:
        work.push(block);
    }
  }
  flushWork();
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function workSection(blocks: Block[], maxDetail: number): string[] {
  const steps = blocks.filter((block) => block.role !== "system" || block.text.trim());
  if (steps.length === 0) return [];
  const label = steps.length === 1 ? "1 step" : `${steps.length} steps`;
  const lines = ["<details>", `<summary>Work: ${label}</summary>`, ""];
  for (const block of steps) lines.push(...stepLines(block, maxDetail), "");
  lines.push("</details>");
  return lines;
}

function stepLines(block: Block, maxDetail: number): string[] {
  switch (block.role) {
    case "reasoning":
      return [`**Thinking**`, "", quote(block.text.trim())];
    case "tool": {
      const title = oneLine(block.tool?.title || block.text) || "Tool call";
      const status = block.tool?.status ? ` (${block.tool.status})` : "";
      const lines = [`**${escapeInline(title)}**${status}`];
      const detail = block.tool?.detail?.trim();
      if (detail) lines.push("", fenced(cut(detail, maxDetail)));
      return lines;
    }
    case "approval": {
      const decided = block.approval?.decided;
      return [
        `**Approval**${decided ? `: ${decided}` : ""}`,
        "",
        quote(block.text.trim()),
      ];
    }
    case "image":
      return [`**Image**: ${oneLine(block.image?.name ?? block.text) || "image"}`];
    case "handoff":
      return [`**Handoff**`, "", quote(block.text.trim())];
    case "assistant":
      return [
        `**${block.notice === "error" ? "Error" : "Stopped"}**`,
        "",
        quote(block.text.trim()),
      ];
    default:
      return [quote(block.text.trim())];
  }
}

function attachmentNames(block: Block): string {
  const names = (block.attachments ?? [])
    .map((attachment) => {
      const value = attachment as { name?: unknown; path?: unknown };
      return typeof value.name === "string"
        ? value.name
        : typeof value.path === "string"
          ? value.path
          : "";
    })
    .filter(Boolean)
    .map((name) => `\`${oneLine(name).replace(/`/g, "'")}\``);
  return names.join(", ");
}

/** A fence longer than any backtick run inside, so output cannot close it. */
export function fenced(text: string, language = "text"): string {
  const longest = Math.max(
    2,
    ...[...text.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

function quote(text: string): string {
  if (!text) return ">";
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… ${text.length - max} more characters left out`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function escapeInline(text: string): string {
  return text.replace(/([\\*_`[\]<>])/g, "\\$1");
}

/** A file name from the title: letters, digits, spaces and dashes only. */
export function exportFileName(title: string, now = new Date()): string {
  const base = title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 60)
    .trim()
    .replace(/^[-.]+/, "");
  const day = now.toISOString().slice(0, 10);
  return `${base || "conversation"} ${day}.md`;
}
