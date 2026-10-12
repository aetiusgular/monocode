// @vitest-environment happy-dom
import { Storage } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyChatFont,
  CHAT_FONT_DEFAULT,
  loadChatFont,
  loadTranscriptDetail,
  saveChatFont,
  saveTranscriptDetail,
  TRANSCRIPT_DETAIL_CHANGE_EVENT,
  TRANSCRIPT_DETAIL_DEFAULT,
} from "./appearance";
import {
  resetTranscriptDetailCache,
  rowStartsOpen,
  useTranscriptDetail,
  workStartsOpen,
} from "../../sessions/hooks/useTranscriptDetail";

beforeEach(() => {
  vi.stubGlobal("localStorage", new Storage());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.documentElement.className = "";
  resetTranscriptDetailCache();
});

afterEach(() => vi.unstubAllGlobals());

describe("chat font (#47)", () => {
  it("defaults to the system font and stores a choice", () => {
    expect(loadChatFont()).toBe(CHAT_FONT_DEFAULT);
    saveChatFont("serif");
    expect(loadChatFont()).toBe("serif");
  });

  it("ignores a stored value it does not know", () => {
    localStorage.setItem("monocode.chatFont", "comic-sans");
    expect(loadChatFont()).toBe("system");
  });

  it("sets exactly one html class, none for the system font", () => {
    const root = document.documentElement.classList;
    applyChatFont("serif");
    expect(root.contains("chat-font-serif")).toBe(true);
    applyChatFont("mono");
    expect(root.contains("chat-font-serif")).toBe(false);
    expect(root.contains("chat-font-mono")).toBe(true);
    applyChatFont("system");
    expect([...root].filter((name) => name.startsWith("chat-font-"))).toEqual(
      [],
    );
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
    expect(loadChatFont()).toBe("system");
    expect(() => saveChatFont("mono")).not.toThrow();
  });
});

describe("transcript detail (#48)", () => {
  it("defaults to summary, which keeps today's folds", () => {
    expect(loadTranscriptDetail()).toBe(TRANSCRIPT_DETAIL_DEFAULT);
    expect(workStartsOpen("summary")).toBe(false);
    expect(rowStartsOpen("summary")).toBe(false);
  });

  it("opens work for steps, and rows too for everything", () => {
    expect(workStartsOpen("steps")).toBe(true);
    expect(rowStartsOpen("steps")).toBe(false);
    expect(workStartsOpen("full")).toBe(true);
    expect(rowStartsOpen("full")).toBe(true);
  });

  it("saves, announces, and refuses unknown values", () => {
    const heard: unknown[] = [];
    const listener = (event: Event) => heard.push((event as CustomEvent).detail);
    window.addEventListener(TRANSCRIPT_DETAIL_CHANGE_EVENT, listener);
    saveTranscriptDetail("full");
    saveTranscriptDetail("bogus" as never);
    window.removeEventListener(TRANSCRIPT_DETAIL_CHANGE_EVENT, listener);
    expect(heard).toEqual(["full", "summary"]);
    expect(loadTranscriptDetail()).toBe("summary");
  });

  it("updates every mounted reader when the setting changes", () => {
    const seen: string[] = [];
    function Probe() {
      seen.push(useTranscriptDetail());
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(createElement(Probe)));
    act(() => saveTranscriptDetail("steps"));
    act(() => root.unmount());
    expect(seen[0]).toBe("summary");
    expect(seen.at(-1)).toBe("steps");
  });
});
