import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMarkdown } from "./AgentMarkdown";

const render = (text: string, allowRemoteMedia = false) =>
  renderToStaticMarkup(createElement(AgentMarkdown, { text, allowRemoteMedia }));

describe("math (#40)", () => {
  it("typesets a display block and inline double-dollar math", () => {
    const markup = render("Energy:\n\n$$\nE = mc^2\n$$\n\nand $$a^2+b^2$$ inline.");
    expect(markup).toContain('class="katex-display"');
    expect(markup.match(/class="katex"/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("leaves single dollars as text", () => {
    const markup = render("It costs $5 and $10 today.");
    expect(markup).not.toContain("katex");
    expect(markup).toContain("$5 and $10");
  });

  it("does not let TeX open links or set classes", () => {
    const markup = render("$$\\href{javascript:alert(1)}{x}\\htmlClass{evil}{y}$$");
    // The TeX source stays as escaped annotation text; nothing becomes a link.
    expect(markup).not.toMatch(/href="javascript:/i);
    expect(markup).not.toMatch(/<a\b[^>]*javascript/i);
    expect(markup).not.toContain('class="evil"');
  });

  it("does not let raw HTML ride in through math", () => {
    const markup = render("$$<img src=x onerror=alert(1)>$$");
    expect(markup).not.toMatch(/<img[^>]*onerror/);
  });
});

describe("html fence (#40)", () => {
  it("offers Render under an html fence in a reply", () => {
    const markup = render("```html\n<p>hi</p>\n```");
    expect(markup).toContain('data-markdown-visual="html"');
    expect(markup).toContain(">Render<");
    // The frame is not mounted until you ask.
    expect(markup).not.toContain("<iframe");
  });

  it("never offers Render for content from strangers", () => {
    const markup = render("```html\n<p>hi</p>\n```", true);
    expect(markup).not.toContain("Render");
    expect(markup).toContain("markdown-code-shell");
  });

  it("leaves other fences alone", () => {
    const markup = render("```js\nconsole.log(1)\n```");
    expect(markup).not.toContain("data-markdown-visual");
  });
});

describe("svg fence (#40)", () => {
  it("shows the source until the drawing is ready", () => {
    const markup = render('```svg\n<svg xmlns="http://www.w3.org/2000/svg"></svg>\n```');
    expect(markup).toContain("markdown-code-shell");
  });
});
