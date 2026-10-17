import { describe, expect, it } from "vitest";
import { COMPUTER_USE_HELPER_NOTE } from "./ComputerUseControl";

describe("the computer-use switch names what it starts (security review S10)", () => {
  it("says a separate app starts outside the sandbox, and apps still ask", () => {
    expect(COMPUTER_USE_HELPER_NOTE).toContain("MonoCode Computer Use");
    expect(COMPUTER_USE_HELPER_NOTE).toContain("outside the sandbox");
    expect(COMPUTER_USE_HELPER_NOTE).toContain("approval");
  });
});
