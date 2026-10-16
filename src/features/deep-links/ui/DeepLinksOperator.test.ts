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

// A link that starts with /operator fills nothing and shows the refusal.

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

async function open(link: string): Promise<AddToChatRequest[]> {
  const seen: AddToChatRequest[] = [];
  const listener = (event: Event) =>
    seen.push((event as CustomEvent<AddToChatRequest>).detail);
  window.addEventListener(ADD_TO_CHAT_EVENT, listener);
  const props = { deps: deps([link]) };
  await act(async () => {
    root.render(createElement(DeepLinks, props));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  window.removeEventListener(ADD_TO_CHAT_EVENT, listener);
  return seen;
}

it.each([
  "/operator list my sessions",
  "/OPERATOR list my sessions",
  "  /Mono list my sessions",
])("%j: nothing reaches the composer, and the alert says why", async (text) => {
  const seen = await open(buildDeepLink(text));
  expect(seen).toHaveLength(0);
  const notice = container.querySelector('[data-deep-link-notice="refused"]');
  expect(notice?.getAttribute("role")).toBe("alert");
  expect(notice?.textContent).toContain(
    "A link cannot turn on app access. Type /operator yourself.",
  );
});

it("an ordinary prompt still fills the composer", async () => {
  const seen = await open(buildDeepLink("Explain what /operator does"));
  expect(seen).toEqual([{ text: "Explain what /operator does", mode: "plain" }]);
  expect(
    container.querySelector('[data-deep-link-notice="filled"]')?.textContent,
  ).toContain("Read it before you send.");
});
