// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { caretSnapshot, insertAtCaret, spacedInsert } from "./insertAtCaret";

function field(value: string, start: number, end = start) {
  const el = document.createElement("textarea");
  document.body.append(el);
  el.value = value;
  el.setSelectionRange(start, end);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("spacedInsert", () => {
  it("adds a space only where the text would run into a word", () => {
    expect(spacedInsert("", "hi", "")).toBe("hi");
    expect(spacedInsert("Fix", "the bug", "")).toBe(" the bug");
    expect(spacedInsert("Fix ", "the bug", "")).toBe("the bug");
    expect(spacedInsert("", "Please", "fix it")).toBe("Please ");
    expect(spacedInsert("a\n", "b", " c")).toBe("b");
  });
});

describe("insertAtCaret", () => {
  it("inserts at the caret captured when recording started", () => {
    const el = field("Fix  please", 4);
    const captured = caretSnapshot(el);
    // Clicking the mic button can move focus; the caret is what was captured.
    el.setSelectionRange(0, 0);
    insertAtCaret(el, "the login bug", captured);
    expect(el.value).toBe("Fix the login bug please");
    expect(el.selectionStart).toBe("Fix the login bug".length);
    expect(el.selectionEnd).toBe(el.selectionStart);
  });

  it("replaces a selection", () => {
    const el = field("Fix the bug", 4, 7);
    insertAtCaret(el, "this", caretSnapshot(el));
    expect(el.value).toBe("Fix this bug");
  });

  it("uses the current caret when the draft changed while recording", () => {
    const el = field("Hello", 5);
    const captured = caretSnapshot(el);
    el.value = "Hello there";
    el.setSelectionRange(0, 0);
    insertAtCaret(el, "Well", captured);
    expect(el.value).toBe("Well Hello there");
  });

  it("fires input so React state follows, and never submits", () => {
    const el = field("", 0);
    const form = document.createElement("form");
    form.append(el);
    document.body.append(form);
    const onInput = vi.fn();
    const onSubmit = vi.fn();
    el.addEventListener("input", onInput);
    form.addEventListener("submit", onSubmit);
    insertAtCaret(el, "dictated", null);
    expect(el.value).toBe("dictated");
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(el);
  });

  it("does nothing for empty text", () => {
    const el = field("keep", 2);
    const onInput = vi.fn();
    el.addEventListener("input", onInput);
    insertAtCaret(el, "", caretSnapshot(el));
    expect(el.value).toBe("keep");
    expect(onInput).not.toHaveBeenCalled();
  });
});
