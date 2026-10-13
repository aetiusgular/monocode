// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveTranscriptDetail } from "../../settings/model/appearance";
import {
  resetTranscriptDetailCache,
  useRowOpen,
  useTranscriptDetail,
} from "./useTranscriptDetail";

// Mac 3.10: Transcript detail set to "Everything" did not reach a transcript
// already open, even after switching tabs; only View, Reload applied it.

let container: HTMLDivElement;
let root: Root;
const rows: Record<string, [boolean, (u: (o: boolean) => boolean) => void]> =
  {};

function Row({ id }: { id: string }) {
  rows[id] = useRowOpen();
  return null;
}

function Detail() {
  return createElement("span", null, useTranscriptDetail());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetTranscriptDetailCache();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("transcript detail on an open transcript", () => {
  it("opens rows when the setting changes to Everything", () => {
    act(() =>
      root.render([
        createElement(Row, { key: "a", id: "a" }),
        createElement(Row, { key: "b", id: "b" }),
      ]),
    );
    expect(rows.a[0]).toBe(false);
    act(() => saveTranscriptDetail("full"));
    expect(rows.a[0]).toBe(true);
    expect(rows.b[0]).toBe(true);
  });

  it("keeps a row the user opened or closed by hand", () => {
    act(() =>
      root.render([
        createElement(Row, { key: "a", id: "a" }),
        createElement(Row, { key: "b", id: "b" }),
      ]),
    );
    act(() => rows.a[1]((open) => !open));
    expect(rows.a[0]).toBe(true);
    act(() => saveTranscriptDetail("full"));
    act(() => rows.b[1]((open) => !open));
    expect(rows.b[0]).toBe(false);
    act(() => saveTranscriptDetail("summary"));
    expect(rows.a[0]).toBe(true);
    expect(rows.b[0]).toBe(false);
  });

  it("reads the new setting after a tab where no transcript was mounted", () => {
    act(() => root.render(createElement(Detail)));
    expect(container.textContent).toBe("summary");
    // Settings takes the tab: the transcript unmounts, then the user picks
    // Everything, then switches back.
    act(() => root.render(null));
    act(() => saveTranscriptDetail("full"));
    act(() => root.render(createElement(Detail)));
    expect(container.textContent).toBe("full");
  });
});
