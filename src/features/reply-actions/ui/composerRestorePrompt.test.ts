// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("../../source-control/hooks/useProjectBranches", () => ({
  useProjectBranchesState: () => ({ branches: undefined, settled: true }),
}));
vi.mock("../../settings/model/sounds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../settings/model/sounds")>()),
  playCue: () => false,
}));

import type {
  Attachment,
  ComposerTurnOptions,
} from "../../sessions/model/session";
import { Composer } from "../../sessions/ui/Composer";

type Restore = (text: string, attachments: Attachment[]) => boolean;
type Submit = (
  text: string,
  attachments: Attachment[],
  options?: ComposerTurnOptions,
) => boolean | void;

let container: HTMLDivElement;
let root: Root;
let restore: Restore | undefined;
const revoked = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  restore = undefined;
  revoked.mockReset();
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revoked);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderComposer(onSubmit: Submit = () => true) {
  await act(async () =>
    root.render(
      createElement(Composer, {
        focused: true,
        harness: "pi",
        model: "pi:default",
        runtimeMode: "supervised",
        executionCwd: "/repo",
        hideProjectPicker: true,
        hideBranchPicker: true,
        onRestorePromptReady: (next) => {
          restore = next;
        },
        onFocus: vi.fn(),
        onCwdChange: vi.fn(),
        onModelChange: vi.fn(),
        onRuntimeModeChange: vi.fn(),
        onSubmit,
      }),
    ),
  );
}

const textarea = () => container.querySelector("textarea")!;

const photo: Attachment = {
  id: "photo",
  name: "shot.png",
  kind: "image",
  mimeType: "image/png",
  size: 4,
  previewUrl: "blob:shot",
};

describe("handing a retried prompt back to the composer", () => {
  it("puts the prompt and its files in an empty composer, ready to send", async () => {
    const onSubmit = vi.fn<Submit>(() => true);
    await renderComposer(onSubmit);
    let taken = false;
    await act(async () => {
      taken = restore!("Describe this screenshot", [photo]);
    });
    expect(taken).toBe(true);
    expect(textarea().value).toBe("Describe this screenshot");
    expect(container.innerHTML).toContain("shot.png");

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send"]')!
        .click(),
    );
    // An ordinary send: the turn it replaced is already gone.
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [text, files, options] = onSubmit.mock.calls[0];
    expect(text).toBe("Describe this screenshot");
    expect(files).toEqual([photo]);
    expect(options?.resendEdited).toBeUndefined();
    // The file came from the chat, so the composer does not free its preview.
    expect(revoked).not.toHaveBeenCalled();
  });

  it("leaves a draft typed since alone", async () => {
    await renderComposer();
    await act(async () => {
      textarea().value = "Something new";
      textarea().dispatchEvent(new Event("input", { bubbles: true }));
    });
    let taken = true;
    await act(async () => {
      taken = restore!("Describe this screenshot", [photo]);
    });
    expect(taken).toBe(false);
    expect(textarea().value).toBe("Something new");
    expect(container.innerHTML).not.toContain("shot.png");
  });
});
