// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  GithubStarPrompt,
  resetGithubStarPromptCacheForTest,
} from "./GithubStarPrompt";
import {
  resetOutboundCallsCache,
  setOutboundCallAllowed,
} from "../../features/settings/model/outboundCalls";

const mocks = vi.hoisted(() => ({
  openUrl: vi.fn(),
  star: vi.fn(),
  starStatus: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("../../features/inbox/model/githubTasks", () => ({
  githubMonocodeStarStatus: mocks.starStatus,
  starMonocodeOnGithub: mocks.star,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  });
  resetOutboundCallsCache();
  resetGithubStarPromptCacheForTest();
  mocks.starStatus.mockReset().mockResolvedValue("notStarred");
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

it("off: no gh call on load or focus, and nothing renders", async () => {
  setOutboundCallAllowed("star-check", false);
  await act(async () => root.render(createElement(GithubStarPrompt)));
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(mocks.starStatus).not.toHaveBeenCalled();
  expect(container.querySelector("[data-github-star-prompt]")).toBeNull();
  expect(container.innerHTML).toBe("");
});

it("on again: checks once and shows the prompt", async () => {
  setOutboundCallAllowed("star-check", false);
  await act(async () => root.render(createElement(GithubStarPrompt)));
  expect(mocks.starStatus).not.toHaveBeenCalled();
  await act(async () => setOutboundCallAllowed("star-check", true));
  expect(mocks.starStatus).toHaveBeenCalledTimes(1);
  expect(container.querySelector("[data-github-star-prompt]")).not.toBeNull();
});

it("turning it off hides a visible prompt and stops focus checks", async () => {
  await act(async () => root.render(createElement(GithubStarPrompt)));
  expect(container.querySelector("[data-github-star-prompt]")).not.toBeNull();
  await act(async () => setOutboundCallAllowed("star-check", false));
  expect(container.querySelector("[data-github-star-prompt]")).toBeNull();
  mocks.starStatus.mockClear();
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(mocks.starStatus).not.toHaveBeenCalled();
});
