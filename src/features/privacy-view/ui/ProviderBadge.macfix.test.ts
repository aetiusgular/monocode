// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    throw new Error(`unexpected ${command}`);
  }),
  isTauri: () => false,
}));

import { privacyView } from "../model/privacyView";
import {
  __resetHarnessServers,
  noteHarnessModelRoute,
} from "../../server-locality/model/sessionServers";
import { ProviderBadge, providerBadgeView } from "./ProviderBadge";

// Mac 5.4 (15 Oct): in a Codex chat on the wrapper home the composer's
// "Home default" badge said "Not known, counted as hosted" while Where data
// goes listed the same route as Local.

const CWD = "/Users/t/s7-gen";
const homeDefault = {
  harness: "codex" as const,
  model: "codex:qwen2.5:7b",
  cwd: CWD,
  providerAccountId: "default",
};
const panelSession = {
  ...homeDefault,
  runtimeMode: "auto" as const,
  blocks: [],
};

/** What the wrapper home's config.toml names, as the harness reports it. */
const OLLAMA_LOCAL = {
  provider: "ollama_local",
  baseUrls: { ollama_local: "http://127.0.0.1:11434/v1" },
  model: "qwen2.5:7b",
};

function report(route: Parameters<typeof noteHarnessModelRoute>[3]) {
  noteHarnessModelRoute("codex", "default", CWD, route);
}

/** Where data goes, model line. */
function panelModel(session: Partial<typeof panelSession> = {}) {
  return privacyView({ ...panelSession, ...session }).destinations[0];
}

beforeEach(() => {
  __resetHarnessServers();
});

describe("the provider badge judges the route as Where data goes does", () => {
  it("a home whose config names a loopback route is Local in both", () => {
    report(OLLAMA_LOCAL);
    const badge = providerBadgeView(homeDefault);
    expect(panelModel()).toMatchObject({
      locality: "local",
      detail: "ollama_local (127.0.0.1:11434), from the harness's own config",
    });
    expect(badge).toEqual({
      label: "Home default",
      locality: "local",
      title:
        "Model provider: Home default. ollama_local (127.0.0.1:11434), from the harness's own config. Local.",
    });
  });

  it("a home whose config names a hosted route is Hosted in both", () => {
    report({
      provider: "corp",
      baseUrls: { corp: "https://llm.corp.example/v1" },
    });
    expect(panelModel().locality).toBe("hosted");
    expect(providerBadgeView(homeDefault)).toEqual({
      label: "Home default",
      locality: "hosted",
      title:
        "Model provider: Home default. corp (llm.corp.example), from the harness's own config. Hosted.",
    });
  });

  it("a route that is truly unknown still counts as hosted", () => {
    // A provider with no base URL that is not OpenAI: nobody can tell.
    report({ provider: "custom", baseUrls: {} });
    expect(panelModel().locality).toBe("unknown");
    expect(providerBadgeView(homeDefault)).toEqual({
      label: "Home default",
      locality: "unknown",
      title:
        "Model provider: Home default. custom, from the harness's own config. Not known, counted as hosted.",
    });
  });

  it("before the harness reports, it says what the panel says", () => {
    expect(panelModel()).toMatchObject({
      locality: "unknown",
      detail: "Set by the harness's own config, not reported to MonoCode yet",
    });
    expect(providerBadgeView(homeDefault)).toEqual({
      label: "Home default",
      locality: "unknown",
      title:
        "Model provider: Home default. Set by the harness's own config, not reported to MonoCode yet. Not known, counted as hosted.",
    });
  });

  it("a provider picked for the chat is judged the same way too", () => {
    report(OLLAMA_LOCAL);
    const ollama = { ...homeDefault, modelProvider: "ollama" };
    expect(providerBadgeView(ollama)).toEqual({
      label: "Ollama",
      locality: "local",
      title: "Model provider: Ollama. Local.",
    });
    expect(panelModel({ modelProvider: "ollama" }).locality).toBe("local");
    const openai = { ...homeDefault, modelProvider: "openai" };
    expect(providerBadgeView(openai).locality).toBe("hosted");
    expect(panelModel({ modelProvider: "openai" }).locality).toBe("hosted");
    // An Ollama cloud model goes to ollama.com through the local Ollama.
    const cloud = { ...ollama, model: "codex:gpt-oss:120b-cloud" };
    expect(providerBadgeView(cloud).locality).toBe("hosted");
    expect(
      panelModel({ modelProvider: "ollama", model: "codex:gpt-oss:120b-cloud" })
        .locality,
    ).toBe("hosted");
  });
});

describe("the badge follows the harness's report", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("turns Local once the route is reported, and so does the menu's Home default", () => {
    act(() =>
      root.render(
        createElement(ProviderBadge, {
          session: homeDefault,
          onChange: () => undefined,
        }),
      ),
    );
    const badge = () =>
      document.querySelector<HTMLButtonElement>(
        "[data-provider-badge] button",
      )!;
    expect(badge().dataset.locality).toBe("unknown");
    expect(badge().title).toContain("Not known, counted as hosted");
    act(() => report(OLLAMA_LOCAL));
    expect(badge().dataset.locality).toBe("local");
    expect(badge().title).toBe(
      "Model provider: Home default. ollama_local (127.0.0.1:11434), from the harness's own config. Local.",
    );
    act(() => badge().click());
    const option = [...document.querySelectorAll('[role="option"]')].find(
      (item) => item.textContent?.startsWith("Home default"),
    )!;
    expect(option.textContent).toContain("Local");
    expect(option.textContent).not.toContain("counted as hosted");
  });
});
