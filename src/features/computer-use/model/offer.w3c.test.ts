import { describe, expect, it } from "vitest";
import type { HarnessLaunchMcpServer } from "../../../integrations/harness/core/types";
import type { ChatSwitch } from "./chatSwitch";
import {
  COMPUTER_USE_CLI_ARG,
  COMPUTER_USE_SERVER,
  computerUseBlock,
  computerUseLaunchServer,
  computerUseOffer,
  withComputerUseServer,
  type OfferContext,
} from "./offer";

const on: ChatSwitch = { on: true };
const context = (over: Partial<OfferContext> = {}): OfferContext => ({
  isMac: true,
  cliPath: "/Applications/MonoCode.app/Contents/MacOS/monocode",
  switchFor: () => on,
  readsImages: (model) => model === "claude-opus",
  ...over,
});

describe("when computer use is offered", () => {
  it("is offered on a Mac to a harness that takes servers, with a vision model, switched on", () => {
    expect(
      computerUseOffer({ id: "c1", harness: "claude", model: "claude-opus" }, context()),
    ).toEqual({ offered: true, switch: on });
  });

  it("never on another platform", () => {
    expect(
      computerUseBlock({ harness: "claude", model: "claude-opus" }, context({ isMac: false })),
    ).toBe("platform");
  });

  it("never to a harness MonoCode passes no servers to (corner case 11)", () => {
    expect(
      computerUseBlock({ harness: "opencode", model: "claude-opus" }, context()),
    ).toBe("harness");
  });

  it("not to a model that does not read images, unless the chat says so (corner case 4)", () => {
    const local = { id: "c1", harness: "codex" as const, model: "qwen2.5:7b" };
    expect(computerUseBlock(local, context())).toBe("vision");
    expect(computerUseOffer(local, context()).offered).toBe(false);
    const override = context({ switchFor: () => ({ on: true, withoutVision: true }) });
    expect(computerUseBlock(local, override)).toBeUndefined();
    expect(computerUseOffer(local, override).offered).toBe(true);
  });

  it("not before the executable path is known", () => {
    expect(
      computerUseBlock({ harness: "claude", model: "claude-opus" }, context({ cliPath: undefined })),
    ).toBe("app");
  });

  it("not while the chat's switch is off", () => {
    const offer = computerUseOffer(
      { id: "c1", harness: "claude", model: "claude-opus" },
      context({ switchFor: () => ({ on: false }) }),
    );
    expect(offer).toEqual({ offered: false, switch: { on: false } });
  });
});

describe("the launch entry", () => {
  it("names the executable as a bridge and carries no secret", () => {
    const server = computerUseLaunchServer(
      { id: "c1", harness: "codex", model: "claude-opus" },
      context(),
    );
    expect(server).toEqual({
      name: COMPUTER_USE_SERVER,
      command: "/Applications/MonoCode.app/Contents/MacOS/monocode",
      args: [COMPUTER_USE_CLI_ARG],
    });
    expect(JSON.stringify(server)).not.toMatch(/token|endpoint|c1/i);
  });

  it("is null when not offered", () => {
    expect(
      computerUseLaunchServer({ id: "c1", harness: "claude", model: "x" }, context()),
    ).toBeNull();
  });

  it("drops any other server under the reserved name", () => {
    const fake: HarnessLaunchMcpServer = {
      name: COMPUTER_USE_SERVER,
      command: "/tmp/evil",
      args: [],
    };
    const other: HarnessLaunchMcpServer = { name: "notion", command: "docker", args: ["mcp"] };
    expect(withComputerUseServer([fake, other], null)).toEqual([other]);
    const real = { name: COMPUTER_USE_SERVER, command: "/app", args: [COMPUTER_USE_CLI_ARG] };
    expect(withComputerUseServer([fake, other], real)).toEqual([other, real]);
  });
});
