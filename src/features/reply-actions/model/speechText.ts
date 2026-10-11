import type { Block } from "../../sessions/model/session";

/** Said in place of a fenced block, so code is never read out character by character. */
export const CODE_BLOCK_MARKER = "Code block.";
/** Said in place of a bare address, which reads as a string of letters and slashes. */
const LINK_MARKER = "link";
/**
 * WebKit stops partway through a long utterance, so a reply is queued as short
 * ones. A sentence longer than this is cut at a comma or a space.
 */
export const SPEECH_CHUNK_LENGTH = 220;

/**
 * The part of a turn worth reading out: what the agent wrote to the reader,
 * and a plan it proposed. Tool rows, reasoning and task lists are left out.
 */
export function replySpeechSource(blocks: readonly Block[]): string {
  return blocks
    .filter((block) => block.role === "assistant" || block.role === "plan")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Markdown as it should sound: one line per paragraph, heading, list item or
 * table row, with the marks taken out and each fenced block replaced by a
 * short marker.
 */
export function speechText(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const spoken: string[] = [];
  let paragraph: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    if (paragraph.length === 0) return;
    const text = inlineSpeech(paragraph.join(" "));
    if (text) spoken.push(text);
    paragraph = [];
  };
  const say = (text: string) => {
    flush();
    const line = inlineSpeech(text);
    if (line) spoken.push(line);
  };

  for (const raw of lines) {
    const fenceMark = /^\s*(?:>\s?)*\s*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (fence) {
      // An unclosed fence runs to the end of the reply, as it renders.
      if (
        fenceMark &&
        fenceMark[0] === fence[0] &&
        fenceMark.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceMark) {
      flush();
      // Two blocks in a row are announced once each; that is what is there.
      spoken.push(CODE_BLOCK_MARKER);
      fence = fenceMark;
      continue;
    }

    const line = raw.replace(/^\s{0,3}(?:>\s?)+/, "").trim();
    if (!line) {
      flush();
      continue;
    }
    // Rules, and the underline of a setext heading.
    if (/^(?:[-*_]\s*){3,}$/.test(line) || /^=+$/.test(line)) {
      flush();
      continue;
    }
    // "[1]: https://..." names a link target and has nothing to say.
    if (/^\[[^\]]+\]:\s+\S+/.test(line)) {
      flush();
      continue;
    }
    // The row of dashes under a table's header.
    if (line.includes("|") && /^[\s|:-]+$/.test(line)) {
      flush();
      continue;
    }
    if (isTableRow(line)) {
      // Cells are read with a pause between them, never the pipes.
      say(
        line
          .replace(/\\\|/g, ESCAPED_PIPE)
          .split("|")
          .map((cell) => cell.split(ESCAPED_PIPE).join("|").trim())
          .filter(Boolean)
          .join(", "),
      );
      continue;
    }
    const heading = /^#{1,6}\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      say(heading[1]);
      continue;
    }
    const item = /^(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (item) {
      flush();
      paragraph.push(item[1]);
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return spoken.join("\n");
}

const ESCAPED_PIPE = "\uE001";

function isTableRow(line: string): boolean {
  return line.startsWith("|") || /\S\s*\|\s*\S.*\|/.test(line);
}

const ENTITIES: Record<string, string> = {
  "&amp;": "and",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/** One line of Markdown without its inline marks. */
function inlineSpeech(source: string): string {
  // Code spans and escaped marks are set aside first, so "*args" in a span
  // and "\*" in a sentence are not taken for emphasis.
  const kept: string[] = [];
  const keep = (literal: string) => {
    kept.push(literal);
    return `\uE000${kept.length - 1}\uE000`;
  };
  let text = source
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, __, body) =>
      keep(String(body).trim()),
    )
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_, mark) => keep(String(mark)));

  text = text
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Images and links keep the words the reader sees.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/\[\^[^\]]+\]/g, " ")
    .replace(/<(?:https?:\/\/|mailto:)[^>\s]+>/g, LINK_MARKER)
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    .replace(/\bhttps?:\/\/[^\s)>\]]+/g, LINK_MARKER)
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/\*(?=\S)([^*]*?\S)\*/g, "$1")
    // An underscore inside a word is part of a name, not emphasis.
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_]*?\S)_(?![\p{L}\p{N}_])/gu, "$1$2")
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp|#39);/g,
      (entity) => ENTITIES[entity],
    );

  return text
    .replace(/\uE000(\d+)\uE000/g, (_, index) => kept[Number(index)] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Speech text cut into pieces short enough to be spoken whole. Lines stay
 * apart, sentences are kept together while they fit, and a sentence that
 * does not fit is cut at a comma, or failing that at a space.
 */
export function speechChunks(
  text: string,
  limit = SPEECH_CHUNK_LENGTH,
): string[] {
  const chunks: string[] = [];
  for (const line of text.split("\n")) {
    let current = "";
    for (const sentence of sentences(line)) {
      for (const piece of fit(sentence, limit)) {
        if (!current) {
          current = piece;
        } else if (current.length + 1 + piece.length <= limit) {
          current = `${current} ${piece}`;
        } else {
          chunks.push(current);
          current = piece;
        }
      }
    }
    if (current) chunks.push(current);
  }
  return chunks;
}

function sentences(line: string): string[] {
  // A full stop only ends a sentence when a space follows: "v1.2" and
  // "file.ts" stay whole. Written without lookbehind, which older WebKit
  // refuses to parse.
  const boundary = /[.!?…]+["')\]]*\s+|[。！？]+\s*/g;
  const parts: string[] = [];
  let start = 0;
  for (let match = boundary.exec(line); match; match = boundary.exec(line)) {
    const end = match.index + match[0].length;
    parts.push(line.slice(start, end).trim());
    start = end;
  }
  parts.push(line.slice(start).trim());
  return parts.filter(Boolean);
}

function fit(sentence: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = sentence;
  while (rest.length > limit) {
    const head = rest.slice(0, limit + 1);
    const comma = Math.max(
      head.lastIndexOf(", "),
      head.lastIndexOf("; "),
      head.lastIndexOf(": "),
    );
    const space = head.lastIndexOf(" ");
    // A comma in the first third would leave a stub, so cut at a space.
    const cut = comma >= limit / 3 ? comma + 1 : space > 0 ? space : limit;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}
