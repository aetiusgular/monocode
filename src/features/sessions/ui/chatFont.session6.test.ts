import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Mac finding 3.9: with the Serif chat font, the user's own message stayed
// sans-serif. Its text is a <pre> with `font-sans`, which the chat font rules
// did not name, so only the "Show more" link changed.
const css = readFileSync("src/styles/index.css", "utf8");
const transcript = readFileSync("src/features/sessions/ui/AgentTranscript.tsx", "utf8");

describe("the chat font reaches the user's own message text", () => {
  it("the plain message text carries the class the rules name", () => {
    expect(transcript).toMatch(/className=\{`user-message-text [^`]*font-sans/);
  });

  for (const font of ["serif", "mono"]) {
    it(`the ${font} rule names the message text`, () => {
      expect(css).toContain(`html.chat-font-${font} .user-message-bubble .user-message-text`);
    });
  }
});
