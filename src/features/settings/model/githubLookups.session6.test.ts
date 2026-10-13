import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  OUTBOUND_CALL_OFF_MESSAGE,
  OUTBOUND_CALLS,
  defaultOutboundCalls,
  outboundCallAllowed,
  resetOutboundCallsCache,
  sanitizeOutboundCalls,
  setOutboundCallAllowed,
} from "./outboundCalls";
import { clearInboxCache, listInboxItems } from "../../inbox/model/githubTasks";
import { resolveLinkedWorkItem } from "../../sessions/model/sessionWorkItem";
import { githubLookupAllowed } from "../../source-control/ui/GitChangesPanel";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

const QUERY = { assignedToMe: false, state: "open" as const, search: "" };
const ghCalls = () =>
  vi
    .mocked(invoke)
    .mock.calls.map(([command]) => String(command))
    .filter(
      (command) =>
        command.startsWith("git_github") || command === "git_pr_status",
    );

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("window", {
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  resetOutboundCallsCache();
  clearInboxCache();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "git_github_repositories") return ["t/s7-gen"];
    if (command === "git_github_work_items") return [];
    if (command === "git_github_repo") return "t/s7-gen";
    if (String(command).endsWith("_status")) return { connected: false };
    return null;
  });
});

describe("GitHub lookups switch (Mac finding 5.9)", () => {
  it("is a fifth outbound call, on by default, stored like the others", () => {
    const call = OUTBOUND_CALLS.find((item) => item.id === "github-lookups");
    expect(call?.label).toBe("GitHub lookups");
    expect(call?.hosts).toEqual(["api.github.com (through gh)"]);
    expect(call?.description).not.toContain("—");
    expect(defaultOutboundCalls()["github-lookups"]).toBe(true);
    expect(outboundCallAllowed("github-lookups")).toBe(true);
    setOutboundCallAllowed("github-lookups", false);
    resetOutboundCallsCache();
    expect(outboundCallAllowed("github-lookups")).toBe(false);
    // Settings saved before the switch existed keep it on.
    expect(sanitizeOutboundCalls({ usage: false })["github-lookups"]).toBe(
      true,
    );
  });

  it("on: the background Inbox check looks the repository up through gh", async () => {
    await listInboxItems([{ path: "/Users/t/s7-gen" }], QUERY, { force: true });
    expect(ghCalls()).toContain("git_github_repositories");
  });

  it("off: the background Inbox check runs no gh, and keeps what it saw", async () => {
    setOutboundCallAllowed("github-lookups", false);
    const result = await listInboxItems([{ path: "/Users/t/s7-gen" }], QUERY, {
      force: true,
      skipGithub: !outboundCallAllowed("github-lookups"),
    });
    expect(ghCalls()).toEqual([]);
    // Reported as not answered, so earlier GitHub items are not dropped.
    expect(result.errors.github).toBe(OUTBOUND_CALL_OFF_MESSAGE);
  });

  it("off: the Inbox opened by the user still asks GitHub", async () => {
    setOutboundCallAllowed("github-lookups", false);
    await listInboxItems([{ path: "/Users/t/s7-gen" }], QUERY, { force: true });
    expect(ghCalls()).toContain("git_github_repositories");
  });

  it("off: a first message naming #12 looks nothing up; a pasted URL still links", async () => {
    setOutboundCallAllowed("github-lookups", false);
    await expect(
      resolveLinkedWorkItem("fix issue #12", "/Users/t/s7-gen", null),
    ).resolves.toBeNull();
    await expect(
      resolveLinkedWorkItem("look at this pr", "/Users/t/s7-gen", null),
    ).resolves.toBeNull();
    expect(ghCalls()).toEqual([]);
    await expect(
      resolveLinkedWorkItem(
        "https://github.com/t/s7-gen/issues/12",
        "/Users/t/s7-gen",
        null,
      ),
    ).resolves.toMatchObject({ repo: "t/s7-gen", number: 12 });
    expect(ghCalls()).toEqual([]);
  });

  it("off: the pull request bar looks up only when the user asked", () => {
    setOutboundCallAllowed("github-lookups", false);
    expect(githubLookupAllowed(false)).toBe(false);
    expect(githubLookupAllowed(true)).toBe(true);
    setOutboundCallAllowed("github-lookups", true);
    expect(githubLookupAllowed(false)).toBe(true);
  });
});
