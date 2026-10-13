// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

let checkpoint: typeof import("./checkpoint");
beforeEach(async () => {
  vi.resetModules();
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  checkpoint = await import("./checkpoint");
});

const HOME_SKIP = { reason: "homeRepository", repository: "/Users/tonyg" };

it("tells the chat once when the repository covers the home folder (Mac 11.16)", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "session_checkpoint_begin_turn" ? HOME_SKIP : undefined,
  );
  const notices: string[] = [];
  const first = await checkpoint.beginSessionTurn(
    "mono",
    "/Users/tonyg",
    undefined,
    (text) => notices.push(text),
  );
  expect(first).toBeUndefined();
  expect(notices).toEqual([
    "No checkpoint for this turn: the repository at /Users/tonyg covers your home folder.",
  ]);
  await checkpoint.beginSessionTurn("mono", "/Users/tonyg", undefined, (text) =>
    notices.push(text),
  );
  expect(notices).toHaveLength(1);
  // No turn to finish: finishing calls nothing.
  await checkpoint.finishSessionTurn("mono", "/Users/tonyg");
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(
        ([command]) => command === "session_checkpoint_finish_turn",
      ),
  ).toEqual([]);
});

it("a second chat in the same home folder is told too", async () => {
  vi.mocked(invoke).mockResolvedValue(HOME_SKIP);
  const notices: string[] = [];
  await checkpoint.beginSessionTurn("a", "/Users/tonyg/code", undefined, (t) =>
    notices.push(t),
  );
  await checkpoint.beginSessionTurn("b", "/Users/tonyg/code", undefined, (t) =>
    notices.push(t),
  );
  expect(notices).toHaveLength(2);
});

it("a normal turn returns its id and shows no notice", async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  const notices: string[] = [];
  const id = await checkpoint.beginSessionTurn(
    "s",
    "/Users/tonyg/my repo",
    undefined,
    (t) => notices.push(t),
  );
  expect(typeof id).toBe("string");
  expect(notices).toEqual([]);
});

it("a failed begin is not reported as a skip", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(invoke).mockRejectedValue("fatal: not a git repository");
  const notices: string[] = [];
  const id = await checkpoint.beginSessionTurn(
    "s",
    "/tmp/plain",
    undefined,
    (t) => notices.push(t),
  );
  expect(typeof id).toBe("string");
  expect(notices).toEqual([]);
  error.mockRestore();
});
