import { describe, expect, it } from "vitest";
import { createFrameLoadGuard } from "./frameLoads";

describe("security review K3: a frame that navigates itself", () => {
  it("takes the first load as the page", () => {
    expect(createFrameLoadGuard().onLoad()).toBe("page");
  });

  it("loads the page again once when it leaves, and blocks it the second time", () => {
    const guard = createFrameLoadGuard();
    expect(guard.onLoad()).toBe("page");
    expect(guard.onLoad()).toBe("reload");
    // The reload itself is the page again.
    expect(guard.onLoad()).toBe("page");
    expect(guard.onLoad()).toBe("block");
    expect(guard.onLoad()).toBe("block");
  });

  it("a new source starts over", () => {
    const guard = createFrameLoadGuard();
    guard.onLoad();
    guard.onLoad();
    guard.onLoad();
    guard.reset();
    expect(guard.onLoad()).toBe("page");
    expect(guard.onLoad()).toBe("reload");
  });
});
