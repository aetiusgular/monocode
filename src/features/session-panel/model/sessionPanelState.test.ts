// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import {
  loadSectionCollapsed,
  loadSessionPanelOpen,
  paneFitsSessionPanel,
  saveSectionCollapsed,
  saveSessionPanelOpen,
  subscribeSectionCollapsed,
  SESSION_PANEL_MIN_PANE_WIDTH,
  sessionHasPanel,
  subscribeSessionPanelOpen,
} from "./sessionPanelState";

describe("session panel open state", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("starts closed", () => {
    expect(loadSessionPanelOpen()).toBe(false);
  });

  it("remembers the viewer's choice under its own key", () => {
    saveSessionPanelOpen(true);
    expect(localStorage.getItem("monocode.sessionPanelOpen")).toBe("1");
    expect(loadSessionPanelOpen()).toBe(true);
    saveSessionPanelOpen(false);
    expect(loadSessionPanelOpen()).toBe(false);
  });

  it("tells subscribers when it changes", () => {
    const onChange = vi.fn();
    const stop = subscribeSessionPanelOpen(onChange);
    saveSessionPanelOpen(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
    saveSessionPanelOpen(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("stays closed, and does not throw, when storage is unavailable", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
    expect(() => saveSessionPanelOpen(true)).not.toThrow();
    expect(loadSessionPanelOpen()).toBe(false);
  });
});

describe("sessionHasPanel", () => {
  const started: Session = {
    ...newSession("claude", "/repo"),
    blocks: [{ id: "u", role: "user", text: "Fix the build" }],
  };

  it("gives a regular session with a transcript the panel", () => {
    expect(sessionHasPanel(started, false)).toBe(true);
  });

  it("leaves a blank session without one", () => {
    expect(sessionHasPanel({ ...started, blocks: [] }, false)).toBe(false);
  });

  it("leaves out a Mono's chat", () => {
    expect(sessionHasPanel(started, true)).toBe(false);
  });

  it("leaves out an orchestration worker", () => {
    expect(
      sessionHasPanel({ ...started, orchestrationLeadId: "lead" }, false),
    ).toBe(false);
  });

  it("leaves out an Inbox conversation", () => {
    const inboxAsk = { key: "github:1" } as unknown as Session["inboxAsk"];
    expect(sessionHasPanel({ ...started, inboxAsk }, false)).toBe(false);
  });
});

describe("paneFitsSessionPanel", () => {
  it("needs room for the panel beside a readable transcript", () => {
    expect(paneFitsSessionPanel(SESSION_PANEL_MIN_PANE_WIDTH)).toBe(true);
    expect(paneFitsSessionPanel(SESSION_PANEL_MIN_PANE_WIDTH - 1)).toBe(false);
    expect(paneFitsSessionPanel(0)).toBe(false);
  });
});

describe("folded sections", () => {
  beforeEach(() => localStorage.clear());

  it("starts with the steps and what the session uses open, its facts folded", () => {
    expect(loadSectionCollapsed("progress")).toBe(false);
    expect(loadSectionCollapsed("used")).toBe(false);
    expect(loadSectionCollapsed("facts")).toBe(true);
  });

  it("remembers each section on its own", () => {
    saveSectionCollapsed("used", true);
    saveSectionCollapsed("facts", false);
    expect(loadSectionCollapsed("used")).toBe(true);
    expect(loadSectionCollapsed("facts")).toBe(false);
    expect(localStorage.getItem("monocode.sessionPanel.usedCollapsed")).toBe(
      "1",
    );
  });

  it("tells subscribers when a section is folded", () => {
    const heard = vi.fn();
    const stop = subscribeSectionCollapsed(heard);
    saveSectionCollapsed("used", true);
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    saveSectionCollapsed("used", false);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
