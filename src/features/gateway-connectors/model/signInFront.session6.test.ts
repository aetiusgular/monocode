// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mac 11.2: after the Notion sign-in through Docker finished, MonoCode did
// not come to the front. The sign-in brings it forward once `oauth ls` says
// authorized, and not when the sign-in is cancelled.

const runDockerMcp = vi.hoisted(() => vi.fn());
const bringAppToFront = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../../platform/tauri/dockerMcp", () => ({ runDockerMcp }));
vi.mock("../../../platform/tauri/appWindow", () => ({ bringAppToFront }));

import { fakeDocker as fakeDockerWith } from "./__fixtures__/fakeDocker";
import {
  __resetInstalled,
  __setSignInPollMs,
  cancelSignIn,
  installedConnector,
  installedState,
  refreshInstalled,
  signInAndTest,
} from "./installed";

const fakeDocker = (initial: Parameters<typeof fakeDockerWith>[1]) =>
  fakeDockerWith(runDockerMcp, initial);

beforeEach(() => {
  localStorage.clear();
  runDockerMcp.mockReset();
  bringAppToFront.mockClear();
  __resetInstalled();
  __setSignInPollMs(1);
});

describe("after a browser sign-in", () => {
  it("brings MonoCode to the front once oauth ls says authorized", async () => {
    const fake = fakeDocker({ profiles: ["notion-remote"] });
    fake.authorizeOpensOnly = true;
    await refreshInstalled();
    const done = signInAndTest(installedConnector("notion-remote")!);
    await vi.waitFor(() =>
      expect(
        runDockerMcp.mock.calls.filter((call) => call[0][2] === "ls").length,
      ).toBeGreaterThan(1),
    );
    expect(bringAppToFront).not.toHaveBeenCalled();
    fake.authorized.add("notion-remote");
    expect(await done).toBe("signed-in");
    expect(bringAppToFront).toHaveBeenCalledTimes(1);
  });

  it("does not when the sign-in is cancelled", async () => {
    const fake = fakeDocker({ profiles: ["notion-remote"] });
    fake.authorizeHangs = true;
    await refreshInstalled();
    const done = signInAndTest(installedConnector("notion-remote")!);
    await vi.waitFor(() => expect(installedState().signingIn).toHaveLength(1));
    cancelSignIn("monocode_notion_remote");
    expect(await done).toBe("cancelled");
    expect(bringAppToFront).not.toHaveBeenCalled();
  });
});
