import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import {
  MAX_ARTIFACT_LINK,
  artifactLinkQuestion,
  artifactLinkTarget,
  confirmArtifactLink,
} from "./artifactLinks";

describe("artifactLinkTarget", () => {
  it("keeps http and https addresses", () => {
    expect(artifactLinkTarget("https://example.com/a?b=1")).toBe(
      "https://example.com/a?b=1",
    );
    expect(artifactLinkTarget("http://example.com")).toBe(
      "http://example.com/",
    );
  });

  it("drops other schemes, bad addresses and non-strings", () => {
    for (const value of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,hi",
      "monocode-harness://open",
      "monoartifact://localhost/x",
      "not a url",
      "",
      42,
      null,
      undefined,
      { href: "https://example.com" },
    ])
      expect(artifactLinkTarget(value)).toBeNull();
  });

  it("drops an address past the length limit", () => {
    const base = "https://example.com/";
    expect(
      artifactLinkTarget(base + "a".repeat(MAX_ARTIFACT_LINK - base.length)),
    ).not.toBeNull();
    expect(
      artifactLinkTarget(base + "a".repeat(MAX_ARTIFACT_LINK - base.length + 1)),
    ).toBeNull();
  });
});

describe("artifactLinkQuestion", () => {
  it("shows a short address whole", () => {
    const question = artifactLinkQuestion("https://example.com/report");
    expect(question).toContain("https://example.com/report");
    expect(question).toContain("an agent wrote");
  });

  it("cuts the middle of a long address and keeps both ends", () => {
    const url = `https://example.com/?q=${"x".repeat(1000)}&end=TAIL`;
    const question = artifactLinkQuestion(url);
    expect(question).toContain("https://example.com/?q=");
    expect(question).toContain("&end=TAIL");
    expect(question).toContain("…");
    expect(question.length).toBeLessThan(560);
    // K6: the site is named whole, and the left-out part is counted.
    expect(question).toContain("Site: example.com");
    expect(question).toMatch(/\(7\d\d characters not shown\)/);
  });

  it("names the site of a short address too", () => {
    expect(artifactLinkQuestion("https://sub.example.org:8443/a")).toContain(
      "Site: sub.example.org:8443",
    );
  });
});

describe("confirmArtifactLink", () => {
  it("returns your answer", async () => {
    const yes = vi.fn().mockResolvedValue(true);
    expect(await confirmArtifactLink("https://example.com/", yes)).toBe(true);
    expect(yes).toHaveBeenCalledWith(
      expect.stringContaining("https://example.com/"),
      { title: "MonoCode", kind: "warning" },
    );
    const no = vi.fn().mockResolvedValue(false);
    expect(await confirmArtifactLink("https://example.com/", no)).toBe(false);
  });

  it("reads a failed dialog as No", async () => {
    const broken = vi.fn().mockRejectedValue(new Error("no dialog"));
    expect(await confirmArtifactLink("https://example.com/", broken)).toBe(
      false,
    );
  });
});
