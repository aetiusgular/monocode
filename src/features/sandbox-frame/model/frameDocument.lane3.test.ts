import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FRAME_MODE,
  FRAME_META_CSP,
  frameMode,
  frameSandbox,
  setFrameMode,
  utf8Length,
  withFrameMeta,
} from "./frameDocument";

describe("withFrameMeta", () => {
  it("puts the policy first in a fragment", () => {
    const out = withFrameMeta("<p>hi</p><script>alert(1)</script>");
    expect(out.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(
      true,
    );
    expect(out.indexOf("<meta")).toBeLessThan(out.indexOf("<script>"));
  });

  it("keeps a doctype first so the page stays in standards mode", () => {
    const out = withFrameMeta("<!DOCTYPE html>\n<html><head></head></html>");
    expect(out.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(out.indexOf("<meta")).toBe("<!DOCTYPE html>".length);
  });

  it("handles a byte order mark and leading space before the doctype", () => {
    const out = withFrameMeta("﻿  <!doctype html><p>x</p>");
    expect(out.indexOf("<meta")).toBeGreaterThan(0);
    expect(out.indexOf("<meta")).toBeLessThan(out.indexOf("<p>"));
  });

  it("cannot be closed early by the page", () => {
    // The page's content comes after the policy, never inside its attribute.
    const out = withFrameMeta('"><script>alert(1)</script>');
    const meta = out.slice(0, out.indexOf(">") + 1);
    expect(meta).toContain(FRAME_META_CSP);
    expect(meta).not.toContain("<script>");
  });

  it("blocks every network route and never allows same origin", () => {
    for (const directive of [
      "default-src 'none'",
      "connect-src 'none'",
      "form-action 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "base-uri 'none'",
    ]) {
      expect(FRAME_META_CSP).toContain(directive);
    }
    expect(FRAME_META_CSP).not.toMatch(/https?:/);
    expect(FRAME_META_CSP).not.toContain("allow-same-origin");
  });
});

describe("frame mode", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("defaults to scripts and reads a stored fallback", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    expect(frameMode()).toBe(DEFAULT_FRAME_MODE);
    setFrameMode("static");
    expect(frameMode()).toBe("static");
    store.set("monocode.sandboxFrame.mode", "allow-same-origin");
    expect(frameMode()).toBe(DEFAULT_FRAME_MODE);
  });

  it("survives storage that throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(frameMode()).toBe(DEFAULT_FRAME_MODE);
    expect(() => setFrameMode("static")).not.toThrow();
  });

  it("maps modes to sandbox attributes", () => {
    expect(frameSandbox("scripts")).toBe("allow-scripts");
    expect(frameSandbox("static")).toBe("");
  });
});

it("counts UTF-8 bytes as the Rust store does", () => {
  expect(utf8Length("abc")).toBe(3);
  expect(utf8Length("é")).toBe(2);
  expect(utf8Length("😀")).toBe(4);
});
