import { describe, expect, it, vi } from "vitest";
import { buildDeepLink } from "./deepLink";
import {
  MAX_LINKS_PER_DELIVERY,
  noticeText,
  startDeepLinks,
  type DeepLinkDeps,
} from "./deepLinkController";
import {
  DeepLinkInbox,
  HANDLED_KEY,
  HANDLED_LIMIT,
  REPEAT_WINDOW_MS,
  type InboxStorage,
} from "./deepLinkInbox";

function memoryStorage(): InboxStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function harness(options: {
  main?: boolean;
  launch?: string[] | null;
  storage?: InboxStorage;
  clock?: { t: number };
}) {
  const clock = options.clock ?? { t: 1_000 };
  let emit: ((urls: string[]) => void) | undefined;
  const unlisten = vi.fn();
  const deps: DeepLinkDeps = {
    isMainWindow: () => options.main ?? true,
    getCurrent: vi.fn(async () => options.launch ?? null),
    onOpenUrl: vi.fn(async (handler) => {
      emit = handler;
      return unlisten;
    }),
    fill: vi.fn(),
    reveal: vi.fn(async () => {}),
    notify: vi.fn(),
    inbox: new DeepLinkInbox(options.storage ?? memoryStorage(), () => clock.t),
  };
  return {
    deps,
    clock,
    unlisten,
    emit: (urls: string[]) => emit?.(urls),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("startDeepLinks", () => {
  it("fills the prompt from a launch link and never sends", async () => {
    const h = harness({ launch: [buildDeepLink("Fix the build")] });
    startDeepLinks(h.deps);
    await flush();
    expect(h.deps.fill).toHaveBeenCalledWith("Fix the build");
    expect(h.deps.fill).toHaveBeenCalledTimes(1);
    expect(h.deps.reveal).toHaveBeenCalledTimes(1);
    expect(h.deps.notify).toHaveBeenCalledWith({ kind: "filled", removed: 0 });
  });

  it("does nothing outside the main window", async () => {
    const h = harness({ main: false, launch: [buildDeepLink("x")] });
    startDeepLinks(h.deps);
    await flush();
    expect(h.deps.getCurrent).not.toHaveBeenCalled();
    expect(h.deps.onOpenUrl).not.toHaveBeenCalled();
    expect(h.deps.fill).not.toHaveBeenCalled();
  });

  it("acts once when a launch link also arrives as an event", async () => {
    const link = buildDeepLink("once");
    const h = harness({ launch: [link] });
    startDeepLinks(h.deps);
    await flush();
    h.clock.t += 100;
    h.emit([link]);
    expect(h.deps.fill).toHaveBeenCalledTimes(1);
  });

  it("does not fill again after a reload (corner case 14)", async () => {
    const storage = memoryStorage();
    const link = buildDeepLink("survives reload?");
    const first = harness({ launch: [link], storage });
    startDeepLinks(first.deps);
    await flush();
    expect(first.deps.fill).toHaveBeenCalledTimes(1);

    // A reload: new inbox on the same session storage, getCurrent repeats.
    const second = harness({
      launch: [link],
      storage,
      clock: { t: first.clock.t + 60_000 },
    });
    startDeepLinks(second.deps);
    await flush();
    expect(second.deps.fill).not.toHaveBeenCalled();
  });

  it("acts again when the same link is clicked later while running", async () => {
    const link = buildDeepLink("again");
    const h = harness({});
    startDeepLinks(h.deps);
    await flush();
    h.emit([link]);
    h.clock.t += REPEAT_WINDOW_MS + 1;
    h.emit([link]);
    expect(h.deps.fill).toHaveBeenCalledTimes(2);
  });

  it("refuses a bad link with a notice, without filling or revealing", async () => {
    const h = harness({});
    startDeepLinks(h.deps);
    await flush();
    h.emit(["monocode-harness://new?prompt=x&autosend=1"]);
    expect(h.deps.fill).not.toHaveBeenCalled();
    expect(h.deps.reveal).not.toHaveBeenCalled();
    expect(h.deps.notify).toHaveBeenCalledWith({
      kind: "refused",
      reason: "The link has a parameter MonoCode does not read.",
    });
  });

  it("caps how many links one delivery may fill", async () => {
    const h = harness({});
    startDeepLinks(h.deps);
    await flush();
    h.emit(
      Array.from({ length: MAX_LINKS_PER_DELIVERY + 3 }, (_, index) =>
        buildDeepLink(`prompt ${index}`),
      ),
    );
    expect(h.deps.fill).toHaveBeenCalledTimes(MAX_LINKS_PER_DELIVERY);
  });

  it("ignores payloads that are not lists of strings", async () => {
    const h = harness({});
    startDeepLinks(h.deps);
    await flush();
    h.emit("monocode-harness://new?prompt=x" as unknown as string[]);
    h.emit([42 as unknown as string]);
    expect(h.deps.fill).not.toHaveBeenCalled();
  });

  it("stops listening when stopped, even before the listener resolves", async () => {
    const h = harness({ launch: [buildDeepLink("late")] });
    const stop = startDeepLinks(h.deps);
    stop();
    await flush();
    expect(h.unlisten).toHaveBeenCalledTimes(1);
    expect(h.deps.fill).not.toHaveBeenCalled();
  });

  it("keeps working when the plugin calls fail", async () => {
    const h = harness({});
    h.deps.getCurrent = vi.fn(async () => {
      throw new Error("no plugin");
    });
    h.deps.reveal = vi.fn(async () => {
      throw new Error("no focus");
    });
    startDeepLinks(h.deps);
    await flush();
    h.emit([buildDeepLink("still fills")]);
    await flush();
    expect(h.deps.fill).toHaveBeenCalledWith("still fills");
  });
});

describe("DeepLinkInbox", () => {
  it("bounds what it remembers and survives bad stored data", () => {
    const storage = memoryStorage();
    storage.setItem(HANDLED_KEY, "{not json");
    const inbox = new DeepLinkInbox(storage, () => 0);
    for (let index = 0; index < HANDLED_LIMIT + 10; index += 1) {
      inbox.accept(`link-${index}`, "event");
    }
    const saved = JSON.parse(storage.getItem(HANDLED_KEY) ?? "[]");
    expect(saved).toHaveLength(HANDLED_LIMIT);
    expect(saved[0]).toBe("link-10");
  });

  it("works with no storage at all", () => {
    const inbox = new DeepLinkInbox(null, () => 0);
    expect(inbox.accept("a", "launch")).toBe(true);
    expect(inbox.accept("a", "launch")).toBe(false);
  });
});

describe("noticeText", () => {
  it("tells you to read the prompt, and how many hidden characters went", () => {
    expect(noticeText({ kind: "filled", removed: 0 })).toBe(
      "A link filled the prompt. Read it before you send.",
    );
    expect(noticeText({ kind: "filled", removed: 1 })).toContain(
      "1 hidden character was removed.",
    );
    expect(noticeText({ kind: "refused", reason: "The link is empty." })).toBe(
      "A link was not used. The link is empty.",
    );
  });
});
