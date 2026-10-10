import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import { runningCallLabel, toolCallDetail } from "./toolCallDetail";

function call(
  text: string,
  tool: NonNullable<Block["tool"]>,
  more: Partial<Block> = {},
): Block {
  return { id: text, role: "tool", text, tool, ...more };
}

describe("toolCallDetail", () => {
  it("pairs a finished command with its output", () => {
    expect(
      toolCallDetail(
        call("npm test", {
          kind: "execute",
          status: "completed",
          detail: "12 passed\n0 failed",
        }),
      ),
    ).toEqual({
      request: "npm test",
      response: "12 passed\n0 failed",
      running: false,
      cut: false,
    });
  });

  it("has nothing to open for a finished call that returned nothing", () => {
    expect(
      toolCallDetail(
        call("git add .", { kind: "execute", status: "completed" }),
      ),
    ).toBeNull();
    // A detail that only says the command again is not output.
    expect(
      toolCallDetail(
        call("git add .", {
          kind: "execute",
          status: "completed",
          detail: "git add .",
        }),
      ),
    ).toBeNull();
  });

  it("does not call a command running once its turn is over", () => {
    // Stop leaves the call open for good. Nothing more is coming from it.
    const stoppedCold = call("npm test", {
      kind: "execute",
      status: "in_progress",
    });
    expect(toolCallDetail(stoppedCold, undefined, false)).toEqual({
      request: "npm test",
      running: false,
      stopped: true,
      cut: false,
    });
    const stoppedMidway = call("npm test", {
      kind: "execute",
      status: "in_progress",
      detail: "3 passed",
    });
    expect(toolCallDetail(stoppedMidway, undefined, false)).toEqual({
      request: "npm test",
      response: "3 passed",
      running: false,
      stopped: true,
      cut: false,
    });
    // The same call in a turn still in flight is running.
    expect(toolCallDetail(stoppedMidway, undefined, true)?.running).toBe(true);
    expect(toolCallDetail(stoppedMidway)?.stopped).toBeUndefined();
    // A finished call is finished whether or not its turn is.
    expect(
      toolCallDetail(
        call("npm test", {
          kind: "execute",
          status: "completed",
          detail: "12 passed",
        }),
        undefined,
        false,
      ),
    ).toEqual({
      request: "npm test",
      response: "12 passed",
      running: false,
      cut: false,
    });
  });

  it("does not show a finished call's own request as its response", () => {
    // Claude Code keeps "Tool: {input}" as the detail of a call that returned
    // no text. That is the request, in full, and there is no response.
    const summary = 'ToolSearch: {"query":"shopify","max_results":10}';
    expect(
      toolCallDetail(
        call("Find shopify", {
          kind: "search",
          status: "completed",
          detail: summary,
        }),
      ),
    ).toEqual({ request: summary, running: false, cut: false });
    // A long input is cut at 400 characters and no longer parses.
    const long = `mcp__docs__search: ${`{"query":"${"x".repeat(500)}`.slice(0, 397)}...`;
    expect(
      toolCallDetail(
        call("Search docs", { status: "completed", detail: long }),
      ),
    ).toEqual({ request: long, running: false, cut: false });
    // A silent command leaves "Bash: command" behind. Nothing to open.
    expect(
      toolCallDetail(
        call("git add .", {
          kind: "execute",
          status: "completed",
          detail: "Bash: git add .",
        }),
      ),
    ).toBeNull();
  });

  it("keeps a finished call's output that only looks like a request", () => {
    for (const output of [
      '{"ok":true}',
      "Result: 3 files changed",
      "Note: {braces} here",
      "git add . was run twice",
    ]) {
      expect(
        toolCallDetail(
          call("git add .", {
            kind: "execute",
            status: "completed",
            detail: output,
          }),
        )?.response,
      ).toBe(output);
    }
  });

  it("shows a running command's output as it comes", () => {
    expect(
      toolCallDetail(
        call("npm test", {
          kind: "execute",
          status: "in_progress",
          detail: "RUN v3\n ✓ a.test.ts",
        }),
      ),
    ).toEqual({
      request: "npm test",
      response: "RUN v3\n ✓ a.test.ts",
      running: true,
      cut: false,
    });
  });

  it("opens a running command that has printed nothing yet", () => {
    expect(
      toolCallDetail(
        call("npm test", { kind: "execute", status: "in_progress" }),
      ),
    ).toEqual({ request: "npm test", running: true, cut: false });
  });

  it("does not take Claude Code's echo of the command for output", () => {
    // While a call runs, Claude Code's detail is "Tool: request".
    expect(
      toolCallDetail(
        call("npm test -- checkout", {
          kind: "execute",
          status: "pending",
          detail: "Bash: npm test -- checkout",
        }),
      ),
    ).toEqual({ request: "npm test -- checkout", running: true, cut: false });
  });

  it("shows a running tool's input as its request", () => {
    const detail = toolCallDetail(
      call("mcp__github__get_issue", {
        kind: "mcp__github__get_issue",
        status: "pending",
        detail: 'mcp__github__get_issue: {"number":482}',
      }),
    );
    expect(detail).toEqual({
      request: 'mcp__github__get_issue: {"number":482}',
      running: true,
      cut: false,
    });
  });

  it("shows what a finished tool returned", () => {
    expect(
      toolCallDetail(
        call("mcp__github__get_issue", {
          kind: "mcp__github__get_issue",
          status: "completed",
          detail: '{"title":"Duplicate charge"}',
        }),
      ),
    ).toEqual({
      request: "mcp__github__get_issue",
      response: '{"title":"Duplicate charge"}',
      running: false,
      cut: false,
    });
  });

  it("says when the output was cut to length", () => {
    const detail = toolCallDetail(
      call("cat big.log", {
        kind: "execute",
        status: "completed",
        detail: `${"x".repeat(8000)}\n…`,
      }),
    );
    expect(detail?.cut).toBe(true);
    expect(detail?.latest).toBeUndefined();
  });

  it("says when a live log shows only its latest lines", () => {
    const detail = toolCallDetail(
      call("npm run build", {
        kind: "execute",
        status: "in_progress",
        detail: `…\n${"x".repeat(8000)}`,
      }),
    );
    expect(detail).toMatchObject({ running: true, cut: true, latest: true });
  });

  it("leaves edits, failures and calls awaiting approval to their own controls", () => {
    expect(
      toolCallDetail(
        call("Edit", {
          kind: "edit",
          status: "completed",
          detail: "The file was updated.",
          preview: { kind: "write", path: "/repo/a.ts" },
        }),
      ),
    ).toBeNull();
    expect(
      toolCallDetail(
        call("npm test", {
          kind: "execute",
          status: "failed",
          detail: "exit 1",
        }),
      ),
    ).toBeNull();
    expect(
      toolCallDetail(
        call(
          "rm -rf build",
          { kind: "execute", status: "pending" },
          { approval: { requestId: 1 } },
        ),
      ),
    ).toBeNull();
  });

  it("is null for anything that is not a tool call", () => {
    expect(
      toolCallDetail({ id: "a", role: "assistant", text: "Done." }),
    ).toBeNull();
  });
});

describe("runningCallLabel", () => {
  const user: Block = { id: "u", role: "user", text: "Fix it" };

  it("names the command in flight", () => {
    expect(
      runningCallLabel([
        user,
        call("npm install", { kind: "execute", status: "completed" }),
        call("npm test", { kind: "execute", status: "in_progress" }),
      ]),
    ).toBe("Running npm test");
  });

  it("says a read, a search and an edit as things happening", () => {
    const running = (text: string, kind: string, preview?: Block["tool"]) =>
      runningCallLabel([
        user,
        call(text, { kind, status: "in_progress", ...preview }),
      ]);
    expect(running("Read src/a.ts", "read")).toBe("Reading src/a.ts");
    expect(running("Find createCharge", "search")).toBe(
      "Searching for createCharge",
    );
    expect(running("Edit src/a.ts", "edit")).toBe("Editing src/a.ts");
  });

  it("is null between calls", () => {
    expect(
      runningCallLabel([
        user,
        call("npm test", { kind: "execute", status: "completed" }),
        { id: "a", role: "assistant", text: "Now the fix.", streaming: true },
      ]),
    ).toBeNull();
    expect(runningCallLabel([user])).toBeNull();
  });

  it("does not call a command waiting on approval running", () => {
    expect(
      runningCallLabel([
        user,
        call(
          "rm -rf build",
          { kind: "execute", status: "pending" },
          { approval: { requestId: 1 } },
        ),
      ]),
    ).toBeNull();
  });

  it("leaves a background command to the line's own wording", () => {
    expect(
      runningCallLabel([
        user,
        call("npm run dev", {
          kind: "execute",
          status: "in_progress",
          background: true,
        }),
      ]),
    ).toBeNull();
  });

  it("names the app's own CLI by its action, not its path", () => {
    expect(
      runningCallLabel([
        user,
        call(
          "/Applications/MonoCode.app/Contents/MacOS/monocode app notes.list --json '{}'",
          {
            kind: "shell",
            status: "in_progress",
          },
        ),
      ]),
    ).toBe("Running monocode app notes.list");
  });
});
