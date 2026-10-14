// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { renderedRangeText } from "./useTranscriptSelection";
import { SELECTABLE_AGENT_RESPONSE_ATTR } from "../model/transcriptSelection";

// Security fix X3: KaTeX draws its visible math as `.katex-html` with
// aria-hidden="true", and keeps a MathML copy for screen readers clipped out
// of sight. Selected math was dropped from the menu text. The visible copy
// is kept and the MathML copy skipped, once.

afterEach(() => {
  document.body.innerHTML = "";
});

const MATHML_STYLES = [
  "position:absolute;clip-path:inset(50%);width:1px;height:1px;overflow:hidden",
  "position:absolute;clip:rect(1px, 1px, 1px, 1px);width:1px;height:1px;overflow:hidden",
];

function reply(mathmlStyle: string) {
  const root = document.createElement("div");
  root.innerHTML = `
    <div ${SELECTABLE_AGENT_RESPONSE_ATTR}="r1">
      <p id="p">Area is <span class="katex"><span class="katex-mathml" style="${mathmlStyle}"><math><semantics><mrow><mi>π</mi><msup><mi>r</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">\\pi r^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base"><span class="mord mathnormal">π</span><span class="mord"><span class="mord mathnormal">r</span><span class="msupsub"><span class="mord mtight">2</span></span></span></span></span></span> here.</p>
      <p id="other">Plain <span aria-hidden="true" id="icon">ICON-HIDDEN</span>text.</p>
    </div>`;
  document.body.append(root);
  return root;
}

function contents(id: string) {
  const range = document.createRange();
  range.selectNodeContents(document.getElementById(id)!);
  return range;
}

describe("renderedRangeText keeps KaTeX math", () => {
  for (const style of MATHML_STYLES) {
    it(`keeps the visible math once and skips the MathML copy (${style.split(";")[1]})`, () => {
      reply(style);
      expect(renderedRangeText(contents("p"))).toBe("Area is πr2 here.");
    });
  }

  it("a selection of only the math keeps it", () => {
    reply(MATHML_STYLES[0]);
    const html = document.querySelector(".katex-html")!;
    const range = document.createRange();
    range.selectNodeContents(html);
    expect(renderedRangeText(range)).toBe("πr2");
  });

  it("aria-hidden outside KaTeX still hides", () => {
    reply(MATHML_STYLES[0]);
    expect(renderedRangeText(contents("other"))).toBe("Plain text.");
  });

  it("a katex-html class outside a .katex element gets no exception", () => {
    const root = document.createElement("div");
    root.innerHTML = `<p id="fake">Shown <span class="katex-html" aria-hidden="true">FAKE-HIDDEN</span>end</p>`;
    document.body.append(root);
    expect(renderedRangeText(contents("fake"))).toBe("Shown end");
  });

  it("math hidden by display none inside KaTeX stays hidden", () => {
    const root = document.createElement("div");
    root.innerHTML = `<p id="none">A <span class="katex"><span class="katex-html" aria-hidden="true">x<span style="display:none">SECRET</span></span></span> B</p>`;
    document.body.append(root);
    expect(renderedRangeText(contents("none"))).toBe("A x B");
  });
});
