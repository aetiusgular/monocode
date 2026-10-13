// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { isTextEntry, settingsEscapeAction } from "./settingsEscape";

// 2.10: Escape that dismissed a macOS autocorrect suggestion closed Settings.

const make = (html: string) => {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild!;
};

describe("settingsEscapeAction", () => {
  it("blurs a focused text field instead of closing", () => {
    expect(settingsEscapeAction(make("<input>"))).toBe("blur");
    expect(settingsEscapeAction(make('<input type="text">'))).toBe("blur");
    expect(settingsEscapeAction(make('<input type="password">'))).toBe("blur");
    expect(settingsEscapeAction(make('<input type="search">'))).toBe("blur");
    expect(settingsEscapeAction(make("<textarea></textarea>"))).toBe("blur");
  });

  it("closes from buttons, checkboxes and the page", () => {
    expect(settingsEscapeAction(make("<button>Set</button>"))).toBe("close");
    expect(settingsEscapeAction(make('<input type="checkbox">'))).toBe("close");
    expect(settingsEscapeAction(document.body)).toBe("close");
    expect(settingsEscapeAction(null)).toBe("close");
    expect(isTextEntry(window)).toBe(false);
  });
});
