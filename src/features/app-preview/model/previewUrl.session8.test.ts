import { describe, expect, it } from "vitest";
import {
  normalizePreviewUrl,
  previewUrlForPort,
  previewUrlFromOutput,
  stripAnsi,
} from "./previewUrl";

describe("normalizePreviewUrl", () => {
  it("keeps loopback addresses and shows them as localhost", () => {
    expect(normalizePreviewUrl("http://localhost:5173/")).toBe("http://localhost:5173/");
    expect(normalizePreviewUrl("http://127.0.0.1:3000")).toBe("http://localhost:3000/");
    expect(normalizePreviewUrl("http://[::1]:8080/app?x=1")).toBe(
      "http://localhost:8080/app?x=1",
    );
    expect(normalizePreviewUrl("http://0.0.0.0:4321/")).toBe("http://localhost:4321/");
    expect(normalizePreviewUrl("https://localhost:8443")).toBe("https://localhost:8443/");
    expect(normalizePreviewUrl("http://localhost/")).toBe("http://localhost:80/");
  });

  it("refuses anything that is not this machine", () => {
    for (const bad of [
      "http://localhost:@evil.example/",
      "http://user@localhost:3000/",
      "http://user:pw@localhost:3000/",
      "http://localhost.evil.example:3000/",
      "http://evil.example/?localhost:3000",
      "http://10.0.0.5:3000/",
      "http://128.0.0.1:3000/",
      "http://127.0.0.256:3000/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ws://localhost:3000/",
      "nonsense",
      "",
    ])
      expect(normalizePreviewUrl(bad), bad).toBeUndefined();
  });
});

describe("previewUrlFromOutput", () => {
  it("finds Vite's address through its colour codes", () => {
    const output =
      "\n  \x1b[32m\x1b[1mVITE\x1b[22m v6.0.0\x1b[39m  ready in 312 ms\n\n  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n  ➜  Network: use --host to expose\n";
    // Vite colours the port inside the URL; the codes are stripped first.
    expect(previewUrlFromOutput(output)).toBe("http://localhost:5173/");
  });

  it("finds Next's and a plain server's address", () => {
    expect(
      previewUrlFromOutput("   ▲ Next.js 15.0.0\n   - Local:        http://localhost:3000\n"),
    ).toBe("http://localhost:3000/");
    expect(previewUrlFromOutput("Serving on http://127.0.0.1:8000.")).toBe(
      "http://localhost:8000/",
    );
    expect(previewUrlFromOutput("listening on http://0.0.0.0:8080")).toBe(
      "http://localhost:8080/",
    );
  });

  it("ignores hosts that are not local, and returns nothing without an address", () => {
    expect(previewUrlFromOutput("Docs at https://vitejs.dev/guide")).toBeUndefined();
    expect(previewUrlFromOutput("compiling…")).toBeUndefined();
    expect(
      previewUrlFromOutput(
        "see https://example.com then Local: http://localhost:4173/",
      ),
    ).toBe("http://localhost:4173/");
  });

  it("strips terminal codes", () => {
    expect(stripAnsi("\x1b[31merror\x1b[0m")).toBe("error");
  });
});

describe("previewUrlForPort", () => {
  it("builds a localhost URL for a valid port only", () => {
    expect(previewUrlForPort(3000)).toBe("http://localhost:3000/");
    expect(previewUrlForPort(0)).toBeUndefined();
    expect(previewUrlForPort(70_000)).toBeUndefined();
    expect(previewUrlForPort(3.5)).toBeUndefined();
  });
});
