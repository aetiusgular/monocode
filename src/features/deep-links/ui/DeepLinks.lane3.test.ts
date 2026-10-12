// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ADD_TO_CHAT_EVENT,
  type AddToChatRequest,
} from "../../sessions/model/quoteDraft";
import { buildDeepLink } from "../model/deepLink";
import { DeepLinkInbox } from "../model/deepLinkInbox";
import { DeepLinks } from "./DeepLinks";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function deps(launch: string[]) {
  return {
    isMainWindow: () => true,
    getCurrent: async () => launch,
    onOpenUrl: async () => () => {},
    // The real fill, so the app's add-to-chat event is what goes out.
    fill: (prompt: string) => {
      window.dispatchEvent(
        new CustomEvent<AddToChatRequest>(ADD_TO_CHAT_EVENT, {
          detail: { text: prompt, mode: "plain" },
        }),
      );
    },
    reveal: async () => {},
    inbox: new DeepLinkInbox(null),
  };
}

it("sends one plain add-to-chat request and shows a notice", async () => {
  const seen: AddToChatRequest[] = [];
  const listener = (event: Event) =>
    seen.push((event as CustomEvent<AddToChatRequest>).detail);
  window.addEventListener(ADD_TO_CHAT_EVENT, listener);
  const props = { deps: deps([buildDeepLink("Explain this repo")]) };
  await act(async () => {
    root.render(createElement(DeepLinks, props));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  window.removeEventListener(ADD_TO_CHAT_EVENT, listener);
  expect(seen).toEqual([{ text: "Explain this repo", mode: "plain" }]);
  const notice = container.querySelector("[data-deep-link-notice]");
  expect(notice?.getAttribute("role")).toBe("status");
  expect(notice?.textContent).toContain("Read it before you send.");
});

it("shows a refusal as an alert and fills nothing", async () => {
  const seen: unknown[] = [];
  const listener = (event: Event) => seen.push(event);
  window.addEventListener(ADD_TO_CHAT_EVENT, listener);
  const props = { deps: deps(["monocode-harness://new"]) };
  await act(async () => {
    root.render(createElement(DeepLinks, props));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  window.removeEventListener(ADD_TO_CHAT_EVENT, listener);
  expect(seen).toHaveLength(0);
  const notice = container.querySelector('[data-deep-link-notice="refused"]');
  expect(notice?.getAttribute("role")).toBe("alert");
  expect(notice?.textContent).toContain("The link has no prompt.");
});

it("renders nothing when no link came", async () => {
  const props = { deps: deps([]) };
  await act(async () => {
    root.render(createElement(DeepLinks, props));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.innerHTML).toBe("");
});
