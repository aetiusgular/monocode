import { describe, expect, it } from "vitest";
import { windowTitleName, type Tab } from "./TitleBar";

// Mac 4.14: the Window menu listed several windows with one title. A chat tab
// named only its project, so windows on one project could not be told apart.

function tab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "t1",
    project: "s7-scratch",
    title: "",
    more: [],
    sessionCount: 1,
    harnesses: [],
    busyHarnesses: [],
    files: [],
    ...overrides,
  };
}

describe("windowTitleName", () => {
  it("names the chat, so two windows on one project differ", () => {
    const main = windowTitleName(tab({ title: "Fix the login form" }));
    const moved = windowTitleName(tab({ title: "HERON42 word memory" }));
    expect(main).toBe("Fix the login form");
    expect(moved).toBe("HERON42 word memory");
    expect(main).not.toBe(moved);
  });

  it("names the file when the tab shows one", () => {
    expect(windowTitleName(tab({ files: ["src/App.tsx"] }))).toBe("App.tsx");
    expect(
      windowTitleName(
        tab({
          multiPane: true,
          fileFocused: true,
          title: "Fix the login form",
          files: ["login.ts"],
        }),
      ),
    ).toBe("login.ts");
    expect(
      windowTitleName(
        tab({ multiPane: true, title: "Fix the login form", files: ["login.ts"] }),
      ),
    ).toBe("Fix the login form");
  });

  it("falls back to the project for a fresh chat, and to nothing with no tab", () => {
    expect(windowTitleName(tab())).toBe("s7-scratch");
    expect(windowTitleName(tab({ title: "   " }))).toBe("s7-scratch");
    expect(windowTitleName(undefined)).toBe("");
  });
});
