import { describe, expect, it } from "vitest";
import { formatPathContext, formatPathsContext } from "./filePathContext";

const CWD = "/Users/ada/project";

describe("formatPathContext (#50)", () => {
  it("mentions a project file by its relative path", () => {
    expect(formatPathContext(`${CWD}/src/app.ts`, CWD)).toBe("@src/app.ts");
    expect(formatPathContext(`${CWD}/-flag.md`, CWD)).toBe("@-flag.md");
  });

  it("uses backticks where a mention cannot carry the name", () => {
    expect(formatPathContext(`${CWD}/my notes.md`, CWD)).toBe("`my notes.md`");
    expect(formatPathContext(`${CWD}/a@b.txt`, CWD)).toBe("`a@b.txt`");
    expect(formatPathContext("/etc/hosts", CWD)).toBe("`/etc/hosts`");
    // The existing mention rule accepts a backtick; the expansion reads the file.
    expect(formatPathContext(`${CWD}/odd\`name.md`, CWD)).toBe("@odd`name.md");
  });

  it("does not treat a sibling folder with the same prefix as the project", () => {
    expect(formatPathContext("/Users/ada/project-old/x.ts", CWD)).toBe(
      "`/Users/ada/project-old/x.ts`",
    );
  });

  it("marks folders with a trailing slash and never expands them", () => {
    expect(formatPathContext(`${CWD}/src`, CWD, true)).toBe("`src/`");
    expect(formatPathContext(`${CWD}/src/`, CWD, true)).toBe("`src/`");
  });

  it("handles Windows separators and no project", () => {
    expect(formatPathContext("C:\\work\\a.ts", "C:\\work")).toBe("@a.ts");
    expect(formatPathContext("rel/a.ts", undefined)).toBe("@rel/a.ts");
  });

  it("joins several entries one per line without repeats", () => {
    expect(
      formatPathsContext(
        [
          { path: `${CWD}/a.ts`, isDir: false },
          { path: `${CWD}/a.ts`, isDir: false },
          { path: `${CWD}/lib`, isDir: true },
        ],
        CWD,
      ),
    ).toBe("@a.ts\n`lib/`");
  });
});
