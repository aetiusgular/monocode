// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runDockerMcp = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/tauri/dockerMcp", () => ({ runDockerMcp }));

import { fakeDocker } from "../model/__fixtures__/fakeDocker";
import { __resetCatalog } from "../model/catalog";
import { __resetInstalled, __setSignInPollMs } from "../model/installed";
import { openConnectorsPage } from "../model/navigation";
import { ConnectorsPage } from "./ConnectorsPage";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  runDockerMcp.mockReset();
  __resetCatalog();
  __resetInstalled();
  __setSignInPollMs(1);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

async function render() {
  await act(async () => {
    root.render(createElement(ConnectorsPage, { cwd: "/repo" }));
  });
  await settle();
}

const byLabel = <T extends Element = HTMLElement>(label: string) =>
  document.querySelector<T & Element>(`[aria-label="${label}"]`);

async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => (element as HTMLElement).click());
  await settle();
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const cardNames = () =>
  Array.from(container.querySelectorAll("[data-connector-card]")).map((card) =>
    card.getAttribute("data-connector-card"),
  );
const card = (name: string) =>
  container.querySelector<HTMLElement>(`[data-connector-card="${name}"]`)!;
const cardState = (name: string) =>
  card(name).getAttribute("data-connector-state");

const calls = () =>
  runDockerMcp.mock.calls.map((call) => (call[0] as string[]).join(" "));

describe("Connectors page", () => {
  it("opens on Discover with the catalog in a grid, and searches it", async () => {
    fakeDocker(runDockerMcp, {});
    await render();
    expect(
      byLabel("Connectors view")?.querySelector('[aria-checked="true"]')
        ?.textContent,
    ).toBe("Discover");
    expect(cardNames()).toEqual([
      "github",
      "gmail-mcp",
      "hugging-face",
      "notion-remote",
      "time",
    ]);
    expect(card("github").textContent).toContain("API key");
    expect(card("notion-remote").textContent).toContain("Sign in");
    expect(card("gmail-mcp").textContent).toContain("API key");

    type(byLabel<HTMLInputElement>("Search connectors")!, "hug");
    expect(cardNames()).toEqual(["hugging-face"]);
    type(byLabel<HTMLInputElement>("Search connectors")!, "");

    const hosted = Array.from(
      byLabel("Where it runs")!.querySelectorAll("button"),
    ).find((button) => button.textContent === "Hosted")!;
    await click(hosted);
    expect(cardNames()).toEqual(["hugging-face", "notion-remote"]);
  });

  it("tests a connector with no setup and shows a check only once it works", async () => {
    fakeDocker(runDockerMcp, {});
    await render();
    await click(byLabel("Add Hugging Face"));
    expect(calls()).toContain(
      "mcp gateway run --profile monocode_hugging_face --dry-run --verbose",
    );
    expect(cardState("hugging-face")).toBe("ready");
    expect(byLabel("Hugging Face works")).not.toBeNull();
    expect(card("hugging-face").textContent).toContain("Works · 4 tools");
  });

  it("shows a failed test as a button that opens the reason", async () => {
    fakeDocker(runDockerMcp, {
      dryRun: {
        time: "warning: pulling docker image mcp/time: Error response from daemon: no matching manifest for linux/arm64/v8\n> 0 tools listed",
      },
    });
    await render();
    await click(byLabel("Add Time"));
    expect(cardState("time")).toBe("failed");
    expect(byLabel("Time works")).toBeNull();
    expect(card("time").textContent).toContain(
      "Failed: No build for Apple Silicon",
    );
    await click(byLabel("Failed: Time"));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Failed: No build for Apple Silicon");
    const details = dialog.querySelector("details")!;
    expect(details.querySelector("summary")?.textContent).toBe("Details");
    expect(details.textContent).toContain("no matching manifest");
  });

  it("opens the setup form when a connector needs keys and settings", async () => {
    fakeDocker(runDockerMcp, {});
    await render();
    await click(byLabel("Add Gmail"));
    expect(calls().some((call) => call.includes("dry-run"))).toBe(false);
    const dialog = document.querySelector('[role="dialog"]')!;
    const form = dialog.querySelector('form[aria-label="Set up"]')!;
    expect(form).not.toBeNull();
    const email = byLabel<HTMLInputElement>("email_address")!;
    expect(email.type).toBe("text");
    expect(document.activeElement).toBe(email);
    expect(form.textContent).toContain("Your Gmail email address");
    // Optional settings wait under More settings.
    const more = form.querySelector("details")!;
    expect(more.querySelector("summary")?.textContent).toBe("More settings");
    expect(more.querySelector('[aria-label="imap_host"]')).not.toBeNull();
    const password = byLabel<HTMLInputElement>("Value for gmail-mcp.password")!;
    expect(password.type).toBe("password");

    type(email, "me@example.com");
    type(password, "app-password");
    const submit = Array.from(form.querySelectorAll("button")).find(
      (button) => button.textContent === "Save and test",
    )!;
    await click(submit);
    expect(calls()).toContain(
      "mcp profile config monocode_gmail_mcp --set gmail-mcp.email_address=me@example.com",
    );
    const secret = runDockerMcp.mock.calls.find((c) => c[0][2] === "set")!;
    expect(secret[1].stdin).toBe("app-password");
    expect(password.value).toBe("");
    expect(document.body.innerHTML).not.toContain("app-password");
    expect(JSON.stringify(localStorage)).not.toContain("app-password");
    expect(calls()).toContain(
      "mcp gateway run --profile monocode_gmail_mcp --dry-run --verbose",
    );
    expect(cardState("gmail-mcp")).toBe("ready");
  });

  it("refuses to save the form with a required setting empty", async () => {
    fakeDocker(runDockerMcp, {});
    await render();
    await click(byLabel("Add Gmail"));
    const form = document.querySelector('form[aria-label="Set up"]')!;
    await click(
      Array.from(form.querySelectorAll("button")).find(
        (button) => button.textContent === "Save and test",
      )!,
    );
    expect(
      document.querySelector('[role="dialog"] [role="alert"]')?.textContent,
    ).toBe("Fill in email_address.");
    expect(
      calls().some((call) => call.includes("config monocode_gmail_mcp --set")),
    ).toBe(false);
  });

  it("starts the sign-in from +, waits with a Cancel, then tests", async () => {
    const fake = fakeDocker(runDockerMcp, {});
    fake.authorizeHangs = true;
    await render();
    await click(byLabel("Add Notion"));
    expect(calls()).toContain(
      "mcp oauth authorize notion-remote --open-browser",
    );
    expect(cardState("notion-remote")).toBe("signing-in");
    expect(card("notion-remote").textContent).toContain(
      "Waiting for sign-in in your browser…",
    );
    expect(byLabel("Cancel sign-in for Notion")).not.toBeNull();

    await act(async () => {
      fake.authorized.add("notion-remote");
    });
    await vi.waitFor(async () => {
      await settle();
      expect(cardState("notion-remote")).toBe("ready");
    });
    expect(calls()).toContain(
      "mcp gateway run --profile monocode_notion_remote --dry-run --verbose",
    );
  });

  it("cancels a sign-in from the card", async () => {
    const fake = fakeDocker(runDockerMcp, {});
    fake.authorizeHangs = true;
    await render();
    await click(byLabel("Add Notion"));
    await click(byLabel("Cancel sign-in for Notion"));
    expect(cardState("notion-remote")).toBe("needs-sign-in");
    expect(byLabel("Sign in: Notion")).not.toBeNull();
  });

  it("signs in from the detail sheet of an added connector", async () => {
    fakeDocker(runDockerMcp, { profiles: ["notion-remote"] });
    openConnectorsPage("yours");
    await render();
    expect(cardNames()).toEqual(["notion-remote"]);
    expect(card("notion-remote").textContent).toContain("Needs sign-in");
    await click(byLabel("Notion details"));
    const signIn = Array.from(
      document.querySelectorAll('[role="dialog"] button'),
    ).find((button) => button.textContent === "Sign in")!;
    await click(signIn);
    expect(runDockerMcp).toHaveBeenCalledWith(
      ["mcp", "oauth", "authorize", "notion-remote", "--open-browser"],
      { timeoutMs: 300_000 },
    );
    await vi.waitFor(async () => {
      await settle();
      expect(cardState("notion-remote")).toBe("ready");
    });
  });

  it("tests untested connectors when Yours opens", async () => {
    fakeDocker(runDockerMcp, { profiles: ["hugging-face"] });
    openConnectorsPage("yours");
    await render();
    await settle();
    expect(calls()).toContain(
      "mcp gateway run --profile monocode_hugging_face --dry-run --verbose",
    );
    expect(cardState("hugging-face")).toBe("ready");
  });

  it("says when Docker Desktop is not running", async () => {
    fakeDocker(runDockerMcp, {
      fail: "Cannot connect to the Docker daemon. Is the docker daemon running?",
    });
    await render();
    expect(
      Array.from(container.querySelectorAll('[role="alert"]')).map(
        (alert) => alert.textContent,
      ),
    ).toContain("Docker Desktop is not running. Open it to use connectors.");
  });

  it("switches tab when asked while open", async () => {
    fakeDocker(runDockerMcp, {});
    await render();
    act(() => openConnectorsPage("yours"));
    expect(
      byLabel("Connectors view")?.querySelector('[aria-checked="true"]')
        ?.textContent,
    ).toBe("Yours");
    expect(container.textContent).toContain("No connectors yet");
  });
});
