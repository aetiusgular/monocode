const TEXT_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "email",
  "url",
  "tel",
  "number",
  "password",
]);

/** A field where Escape may only mean "dismiss the autocorrect suggestion". */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as HTMLElement;
  const tag = element.tagName?.toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "input") {
    const type = (element.getAttribute("type") ?? "").toLowerCase();
    return TEXT_INPUT_TYPES.has(type);
  }
  return element.isContentEditable === true;
}

/**
 * Escape in Settings. In a focused text field it blurs the field: macOS
 * also sends Escape to dismiss an autocorrect suggestion, and closing
 * Settings then threw away what was typed. Anywhere else it closes.
 */
export function settingsEscapeAction(
  target: EventTarget | null,
): "blur" | "close" {
  return isTextEntry(target) ? "blur" : "close";
}
