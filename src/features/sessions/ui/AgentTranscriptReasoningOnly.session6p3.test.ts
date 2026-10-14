import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Block } from "../model/session";
import { EMPTY_TURN_NOTICE } from "../model/emptyTurn";
import { AgentTranscript } from "./AgentTranscript";

// Mac 3.7 retest: a finished turn with only reasoning kept its "Thinking…"
// placeholder, so it read as still working.

const blocks: Block[] = [
  { id: "u", role: "user", text: "svg of a red circle" },
  { id: "r", role: "reasoning", text: "I should draw a circle." },
];

const render = (list: Block[], busy: boolean) =>
  renderToStaticMarkup(createElement(AgentTranscript, { blocks: list, busy }));

describe("a reasoning-only turn", () => {
  it("shows Thinking… while the turn is live", () => {
    expect(render(blocks, true)).toContain("Thinking…");
  });

  it("drops Thinking… once the turn completed and shows the notice", () => {
    const markup = render(
      [
        ...blocks,
        { id: "n", role: "system", text: EMPTY_TURN_NOTICE, notice: "error" },
      ],
      false,
    );
    expect(markup).not.toContain("Thinking…");
    expect(markup).toContain("The model finished this turn without a reply");
  });
});
