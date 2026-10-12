// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => undefined),
}));
const gh = vi.hoisted(() => ({
  item: vi.fn(),
  details: vi.fn(),
}));
vi.mock("../../inbox/model/githubTasks", () => ({
  formatRelativeTime: () => "",
  githubWorkItem: gh.item,
  githubWorkItemDetails: gh.details,
  peekGithubWorkItem: () => null,
  peekGithubWorkItemDetails: () => null,
}));

import { UserLinkPreview } from "./UserLinkPreview";
import { parseUserMessageLink } from "../model/linkPreview";
import {
  resetOutboundCallsCache,
  setOutboundCallAllowed,
} from "../../settings/model/outboundCalls";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  });
  resetOutboundCallsCache();
  invoke
    .mockReset()
    .mockResolvedValue({ title: "Example", faviconDataUrl: null });
  gh.item.mockReset().mockResolvedValue(null);
  gh.details.mockReset().mockResolvedValue(null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  resetOutboundCallsCache();
});

const web = parseUserMessageLink("see https://example.com/page ok")!.link;
const pr = parseUserMessageLink("https://github.com/o/r/pull/7")!.link;

it("off: a web link renders as a plain link with no fetch and no spinner", async () => {
  setOutboundCallAllowed("link-previews", false);
  await act(async () =>
    root.render(createElement(UserLinkPreview, { link: web })),
  );
  const anchor = container.querySelector("a")!;
  expect(anchor.hasAttribute("data-user-link-plain")).toBe(true);
  expect(anchor.getAttribute("href")).toBe("https://example.com/page");
  expect(anchor.textContent).toBe("example.com/page");
  expect(container.querySelector("img, .animate-spin, [aria-busy]")).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});

it("off: a GitHub link makes no gh call, even on focus", async () => {
  setOutboundCallAllowed("link-previews", false);
  await act(async () =>
    root.render(createElement(UserLinkPreview, { link: pr })),
  );
  const anchor = container.querySelector("a")!;
  expect(anchor.hasAttribute("data-user-link-plain")).toBe(true);
  await act(async () => anchor.focus());
  expect(gh.item).not.toHaveBeenCalled();
  expect(gh.details).not.toHaveBeenCalled();
});

it("on again: the preview fetches its title", async () => {
  setOutboundCallAllowed("link-previews", false);
  await act(async () =>
    root.render(createElement(UserLinkPreview, { link: web })),
  );
  expect(invoke).not.toHaveBeenCalled();
  await act(async () => setOutboundCallAllowed("link-previews", true));
  expect(invoke).toHaveBeenCalledWith("fetch_link_preview", {
    url: "https://example.com/page",
  });
  expect(container.textContent).toContain("Example");
});

it("on: a GitHub link asks gh when focused", async () => {
  await act(async () =>
    root.render(createElement(UserLinkPreview, { link: pr })),
  );
  await act(async () => container.querySelector("a")!.focus());
  expect(gh.item).toHaveBeenCalledTimes(1);
});

it("static render with the switch off has no spinner", () => {
  setOutboundCallAllowed("link-previews", false);
  const html = renderToStaticMarkup(
    createElement(UserLinkPreview, { link: pr }),
  );
  expect(html).toContain("data-user-link-plain");
  expect(html).not.toContain("animate-spin");
});
