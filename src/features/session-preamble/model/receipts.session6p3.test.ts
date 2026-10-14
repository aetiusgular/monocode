import { beforeEach, describe, expect, it } from "vitest";
import {
  appReceiptKey,
  conversationGiven,
  forgetAppReceipt,
  forgetPreamble,
  hasPreambleReceipt,
  instructionsStale,
  preambleDue,
  recordInstructions,
  recordPreamble,
} from "./receipts";

// Security review W3: receipts were a plain object read with `in` and
// brackets, so `toString` or `__proto__` read as a receipt already given,
// and a chat id holding `#` could name another chat's app receipt.

const KEY = "monocode.preambleReceipts";

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

describe("receipts never read inherited names", () => {
  it.each(["toString", "__proto__", "constructor", "hasOwnProperty"])(
    "%s has no receipt before one is recorded",
    (id) => {
      expect(hasPreambleReceipt(id)).toBe(false);
      expect(preambleDue(id, "p1", "h1")).toBe(true);
      expect(conversationGiven(id, "p1")).toBe(false);
      expect(instructionsStale(id, "p1", "h1")).toBe(false);
      // Forgetting a receipt that is not there does not throw or write.
      forgetPreamble(id);
      forgetAppReceipt(id);
      expect(localStorage.getItem(KEY)).toBeNull();
    },
  );

  it("a __proto__ key in storage does not become a receipt for every id", () => {
    localStorage.setItem(
      KEY,
      '{"__proto__":{"hash":"h1","at":1},"s1":{"hash":"h1","at":1}}',
    );
    expect(hasPreambleReceipt("s1")).toBe(true);
    expect(hasPreambleReceipt("other")).toBe(false);
    expect(preambleDue("other", "p1", "h1")).toBe(true);
  });

  it("records and reads back a chat named like a builtin", () => {
    recordPreamble("constructor", "p1", "h1");
    expect(preambleDue("constructor", "p1", "h1")).toBe(false);
    expect(hasPreambleReceipt("toString")).toBe(false);
  });
});

describe("a chat id holding # gets no receipt", () => {
  it("cannot record or read the app receipt of another chat", () => {
    recordPreamble(appReceiptKey("s1"), "p1", "app-h");
    expect(preambleDue(appReceiptKey("s1"), "p1", "app-h")).toBe(false);
    // A chat whose id is "s1#app" is refused, not mixed with s1's app receipt.
    expect(hasPreambleReceipt("s1#app")).toBe(false);
    expect(conversationGiven("s1#app", "p1")).toBe(false);
    recordInstructions("s1#app", "p9", "x", { startedNow: true, native: true });
    expect(preambleDue(appReceiptKey("s1"), "p1", "app-h")).toBe(false);
    forgetPreamble("s1#app");
    expect(preambleDue(appReceiptKey("s1"), "p1", "app-h")).toBe(false);
  });

  it("drops a stored key with # that is not an app receipt", () => {
    localStorage.setItem(
      KEY,
      '{"a#b":{"hash":"h","at":1},"a#app":{"hash":"h","at":1}}',
    );
    expect(preambleDue("a#b", "p1", "h")).toBe(true);
    expect(preambleDue(appReceiptKey("a"), "p1", "h")).toBe(false);
  });

  it("forgetting a chat removes both of its receipts", () => {
    recordPreamble("s2", "p1", "h");
    recordPreamble(appReceiptKey("s2"), "p1", "a");
    forgetPreamble("s2");
    expect(hasPreambleReceipt("s2")).toBe(false);
    expect(preambleDue(appReceiptKey("s2"), "p1", "a")).toBe(true);
  });
});
