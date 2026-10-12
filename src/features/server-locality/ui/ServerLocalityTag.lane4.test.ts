import { beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { nextServerMark, ServerLocalityTag } from "./ServerLocalityTag";
import { resetServerMarksCache, setServerMark } from "../model/serverMarks";

function mockLocalStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
      key: () => null,
      length: 0,
    },
    configurable: true,
  });
}

beforeEach(() => {
  mockLocalStorage();
  resetServerMarksCache();
});

describe("ServerLocalityTag", () => {
  it("cycles not marked, local, hosted, not marked", () => {
    expect(nextServerMark(undefined)).toBe("local");
    expect(nextServerMark("local")).toBe("hosted");
    expect(nextServerMark("hosted")).toBeUndefined();
  });

  it("shows an unmarked stdio server as not marked, counting as hosted", () => {
    const html = renderToStaticMarkup(
      createElement(ServerLocalityTag, { server: { name: "ace-kg" } }),
    );
    expect(html).toContain("Not marked");
    expect(html).toContain('data-server-locality="unknown"');
    expect(html).toContain("Click to mark it local.");
  });

  it("shows your mark", () => {
    setServerMark("ace-kg", "local");
    const html = renderToStaticMarkup(
      createElement(ServerLocalityTag, { server: { name: "ace-kg" } }),
    );
    expect(html).toContain("Local");
    expect(html).toContain("Click to mark it hosted.");
  });

  it("shows a remote server as hosted, read only when asked", () => {
    const html = renderToStaticMarkup(
      createElement(ServerLocalityTag, {
        server: { name: "exa", url: "https://mcp.exa.ai/mcp" },
        editable: false,
      }),
    );
    expect(html).toContain("Hosted");
    expect(html).not.toContain("<button");
  });
});
