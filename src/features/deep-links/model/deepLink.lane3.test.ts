import { describe, expect, it } from "vitest";
import {
  buildDeepLink,
  cleanLinkText,
  DEEP_LINK_SCHEME,
  MAX_LINK_LENGTH,
  MAX_PROMPT_LENGTH,
  parseDeepLink,
} from "./deepLink";

function prompt(raw: string): string | null {
  const result = parseDeepLink(raw);
  return result.ok ? result.prompt : null;
}

describe("parseDeepLink", () => {
  it("reads the prompt from the one accepted shape", () => {
    expect(prompt("monocode-harness://new?prompt=Fix%20the%20tests")).toBe(
      "Fix the tests",
    );
    expect(prompt("monocode-harness://new/?prompt=a+b")).toBe("a b");
    expect(prompt("MONOCODE-HARNESS://NEW?prompt=x")).toBe("x");
  });

  it("round-trips a prompt built with buildDeepLink", () => {
    const text = 'Line one\nLine two & three = 100% "quoted" #hash ?q';
    expect(prompt(buildDeepLink(text))).toBe(text);
  });

  it("keeps tabs and newlines and unifies line endings", () => {
    expect(prompt(buildDeepLink("a\r\nb\rc\td"))).toBe("a\nb\nc\td");
  });

  it("refuses other schemes, including upstream's and web links", () => {
    for (const raw of [
      "monocode://new?prompt=x",
      "https://new?prompt=x",
      "javascript:alert(1)",
      "file:///etc/passwd",
    ]) {
      expect(parseDeepLink(raw).ok).toBe(false);
    }
  });

  it("refuses other actions, paths, user info and ports", () => {
    for (const raw of [
      `${DEEP_LINK_SCHEME}://send?prompt=x`,
      `${DEEP_LINK_SCHEME}://new/../send?prompt=x`,
      `${DEEP_LINK_SCHEME}://new/extra?prompt=x`,
      `${DEEP_LINK_SCHEME}://user:pw@new?prompt=x`,
      `${DEEP_LINK_SCHEME}://new:8080?prompt=x`,
    ]) {
      expect(parseDeepLink(raw)).toMatchObject({ ok: false });
    }
  });

  it("refuses unknown parameters, a missing prompt and two prompts", () => {
    expect(parseDeepLink(`${DEEP_LINK_SCHEME}://new?prompt=x&send=1`)).toEqual({
      ok: false,
      reason: "The link has a parameter MonoCode does not read.",
    });
    expect(parseDeepLink(`${DEEP_LINK_SCHEME}://new`)).toEqual({
      ok: false,
      reason: "The link has no prompt.",
    });
    expect(
      parseDeepLink(`${DEEP_LINK_SCHEME}://new?prompt=a&prompt=b`),
    ).toEqual({ ok: false, reason: "The link has more than one prompt." });
  });

  it("refuses empty, unreadable and non-string input", () => {
    expect(parseDeepLink("").ok).toBe(false);
    expect(parseDeepLink(undefined).ok).toBe(false);
    expect(parseDeepLink(42).ok).toBe(false);
    expect(parseDeepLink("not a url").ok).toBe(false);
    expect(parseDeepLink(`${DEEP_LINK_SCHEME}://new?prompt=%20%0A%09`)).toEqual(
      { ok: false, reason: "The link's prompt is empty." },
    );
  });

  it("refuses a prompt over the limit rather than cutting it", () => {
    const atLimit = "a".repeat(MAX_PROMPT_LENGTH);
    expect(prompt(buildDeepLink(atLimit))).toBe(atLimit);
    const over = parseDeepLink(buildDeepLink(`${atLimit}b`));
    expect(over.ok).toBe(false);
  });

  it("refuses a link over the length limit before parsing it", () => {
    const raw = `${DEEP_LINK_SCHEME}://new?prompt=${"a".repeat(MAX_LINK_LENGTH)}`;
    expect(parseDeepLink(raw)).toEqual({
      ok: false,
      reason: "The link is too long.",
    });
  });

  it("strips hidden characters and counts them", () => {
    const hidden = "run‮ tests​ now\u0007⁦";
    const result = parseDeepLink(buildDeepLink(hidden));
    expect(result).toEqual({ ok: true, prompt: "run tests now", removed: 4 });
  });

  it("takes names with spaces and a leading dash literally", () => {
    expect(prompt(buildDeepLink("open -rf my file.txt"))).toBe(
      "open -rf my file.txt",
    );
  });
});

describe("cleanLinkText", () => {
  it("removes C0, DEL and C1 controls but keeps tab and newline", () => {
    expect(cleanLinkText("a\u0000b\u007fc\u0085d\te\nf")).toEqual({
      text: "abcd\te\nf",
      removed: 3,
    });
  });
});
