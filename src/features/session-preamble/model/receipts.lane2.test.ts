import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetPreamble,
  hasPreambleReceipt,
  preambleDue,
  RECEIPTS_MAX,
  recordPreamble,
} from "./receipts";

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

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
});

describe("F2: receipts", () => {
  it("sends once per provider session and hash", () => {
    expect(preambleDue("s1", "p1", "h1")).toBe(true);
    recordPreamble("s1", "p1", "h1");
    expect(preambleDue("s1", "p1", "h1")).toBe(false);
    // Changed text goes again.
    expect(preambleDue("s1", "p1", "h2")).toBe(true);
    // A new provider conversation (harness or model switch, lost resume) too.
    expect(preambleDue("s1", "p2", "h1")).toBe(true);
  });

  it("binds a receipt made before the first reply to whatever came next", () => {
    recordPreamble("s1", undefined, "h1");
    expect(preambleDue("s1", "p9", "h1")).toBe(false);
    // Without a provider session there is nothing to bind to yet.
    expect(preambleDue("s1", undefined, "h1")).toBe(true);
  });

  it("is sent again after forgetting (compaction, Send instructions again)", () => {
    recordPreamble("s1", "p1", "h1");
    forgetPreamble("s1");
    expect(hasPreambleReceipt("s1")).toBe(false);
    expect(preambleDue("s1", "p1", "h1")).toBe(true);
  });

  it("survives a reload and drops bad stored data (corner case 14)", () => {
    recordPreamble("s1", "p1", "h1");
    // Same storage, fresh read.
    expect(preambleDue("s1", "p1", "h1")).toBe(false);
    localStorage.setItem("monocode.preambleReceipts", "{not json");
    expect(preambleDue("s1", "p1", "h1")).toBe(true);
    localStorage.setItem(
      "monocode.preambleReceipts",
      JSON.stringify({
        s1: { hash: 5 },
        s2: "x",
        s3: { hash: "h", provider: "p" },
      }),
    );
    expect(preambleDue("s1", "p1", "h")).toBe(true);
    expect(preambleDue("s3", "p", "h")).toBe(false);
  });

  it("keeps at most RECEIPTS_MAX, newest first", () => {
    for (let index = 0; index <= RECEIPTS_MAX; index++)
      recordPreamble(`s${index}`, "p", "h", index);
    expect(hasPreambleReceipt("s0")).toBe(false);
    expect(hasPreambleReceipt(`s${RECEIPTS_MAX}`)).toBe(true);
  });
});
