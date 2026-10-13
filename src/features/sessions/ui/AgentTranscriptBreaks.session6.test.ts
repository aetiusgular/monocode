import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Block } from "../model/session";
import { AgentTranscript } from "./AgentTranscript";

// 11.x: numbers asked for "one per line" ran together into one paragraph.
// A single newline in an agent reply is a line break, as on GitHub and in
// the Claude app.

function reply(text: string, streaming = false): string {
  const blocks: Block[] = [
    { id: "user", role: "user", text: "Count to three, one per line." },
    { id: "answer", role: "assistant", text, streaming },
  ];
  return renderToStaticMarkup(
    createElement(AgentTranscript, { blocks, busy: streaming }),
  );
}

describe("agent replies keep single newlines", () => {
  it("puts each line of a paragraph on its own line", () => {
    expect(reply("1\n2\n3")).toContain("<p>1<br/>2<br/>3</p>");
  });

  it("keeps the breaks while the reply streams", () => {
    expect(reply("one\ntwo", true)).toMatch(/one(<\/span>)?<br\/>/);
  });

  it("leaves code blocks alone", () => {
    const markup = reply("```sh\nls -la\ncd ./-dash dir\n```");
    expect(markup).not.toMatch(/ls -la<br/);
    expect(markup).toContain("cd ./-dash dir");
  });

  it("does not add breaks between list items or table rows", () => {
    const list = reply("- a\n- b\n\n1. one\n2. two");
    expect(list).not.toContain("<br/>");
    const table = reply("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(table).toContain("<table");
    expect(table).not.toContain("<br/>");
  });

  it("does not break display math", () => {
    const markup = reply("$$\na = b\n+ c\n$$");
    expect(markup).toContain("katex");
    expect(markup).not.toMatch(/a = b<br/);
  });

  it("keeps a blank line as a paragraph break", () => {
    const markup = reply("first\n\nsecond");
    expect(markup).toContain("<p>first</p>");
    expect(markup).toContain("<p>second</p>");
  });
});
