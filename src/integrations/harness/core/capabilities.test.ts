import { describe, expect, it } from "vitest";
import {
  HARNESSES,
  type HarnessId,
} from "../../../features/sessions/model/session";
import {
  harnessSupportsAttachments,
  harnessSupportsConnectorSwitches,
  harnessSupportsExtraDirs,
  harnessSupportsSkillSwitches,
  harnessSupportsToolAccess,
} from "../../../features/sessions/model/session";
import { harnessSupportsEditLastTurn } from "../../../features/sessions/model/editLastTurn";
import { harnessSupportsResearch } from "../../../features/research-mode/model/visibility";
import { harnessSupportsPluginSwitches } from "../../../features/claude-plugins/model/chatPlugins";
import { registerBuiltinHarnesses } from "./register";
import {
  canCompactHarnessContext,
  canRunHarnessTextPrompt,
  canSteerHarness,
  getHarness,
} from "./registry";
import { BASELINE, harnessCan, harnessCapabilities } from "./capabilities";

const only = (ids: HarnessId[]) => (id: HarnessId) => ids.includes(id);
const except = (ids: HarnessId[]) => (id: HarnessId) => !ids.includes(id);

// The literal checks the table replaced, as they read at 891b98e and v0.12.0.
// Reading the table must change no behaviour.
const BEFORE: [
  string,
  (id: HarnessId) => boolean,
  (id: HarnessId) => boolean,
][] = [
  ["attachments", harnessSupportsAttachments, except(["fx"])],
  ["extraDirs", harnessSupportsExtraDirs, only(["claude", "codex"])],
  [
    "connectorSwitches",
    harnessSupportsConnectorSwitches,
    only(["claude", "codex"]),
  ],
  ["toolAccess", harnessSupportsToolAccess, only(["claude", "codex"])],
  // Devin joined with v0.12.0 and runs its own commands; the old literal
  // check missed it, and chatSkills.test.ts caught that.
  [
    "skillSwitches",
    harnessSupportsSkillSwitches,
    except(["pi", "omp", "devin"]),
  ],
  ["research", harnessSupportsResearch, only(["claude", "codex"])],
  ["pluginSwitches", harnessSupportsPluginSwitches, only(["claude"])],
  [
    "editLastTurn",
    harnessSupportsEditLastTurn,
    only(["pi", "omp", "codex", "claude", "opencode"]),
  ],
];

describe("harness capability table", () => {
  it("has a record for every harness", () => {
    for (const id of HARNESSES) {
      expect(harnessCapabilities(id), id).toBeTruthy();
    }
  });

  it.each(BEFORE)(
    "keeps %s as it was for every harness",
    (_name, now, then) => {
      for (const id of HARNESSES) {
        expect(now(id), id).toBe(then(id));
      }
    },
  );

  it("gives a harness it does not know the baseline", () => {
    const unknown = "newharness" as HarnessId;
    expect(harnessCapabilities(unknown)).toEqual(BASELINE);
    expect(harnessSupportsAttachments(unknown)).toBe(true);
    expect(harnessSupportsExtraDirs(unknown)).toBe(false);
    expect(harnessSupportsEditLastTurn(unknown)).toBe(false);
  });

  it("marks Codex alone as sandboxed", () => {
    const sandboxed = HARNESSES.filter((id) => harnessCan(id, "sandboxed"));
    expect(sandboxed).toEqual(["codex"]);
    // Step 3: every other harness, Devin included, is shown unsandboxed.
    expect(HARNESSES.length - sandboxed.length).toBe(10);
  });

  it("takes a model provider per chat on Codex only", () => {
    const takes = HARNESSES.filter((id) => harnessCan(id, "modelProvider"));
    expect(takes).toEqual(["codex"]);
  });

  it("leaves prompt suggestions off until one is seen to arrive", () => {
    for (const id of HARNESSES) {
      expect(harnessCan(id, "promptSuggestions"), id).toBe(false);
    }
  });

  it("sets native upgrades only for Claude Code and Codex", () => {
    for (const id of HARNESSES) {
      const caps = harnessCapabilities(id);
      const native =
        caps.instructions !== "none" ||
        caps.rewind === "anyTurn" ||
        caps.fork !== "none" ||
        caps.backgroundList ||
        caps.backgroundStop ||
        caps.mcpInject ||
        caps.listSessions !== "none";
      expect(native, id).toBe(id === "claude" || id === "codex");
    }
    expect(harnessCan("claude", "instructions")).toBe("system");
    expect(harnessCan("codex", "instructions")).toBe("session");
  });

  it("matches what the registered adapters can do", () => {
    registerBuiltinHarnesses();
    for (const id of HARNESSES) {
      expect(getHarness(id), id).toBeTruthy();
      expect(harnessCan(id, "steer"), `${id} steer`).toBe(canSteerHarness(id));
      expect(harnessCan(id, "compact"), `${id} compact`).toBe(
        canCompactHarnessContext(id),
      );
      expect(harnessCan(id, "textPrompt"), `${id} textPrompt`).toBe(
        canRunHarnessTextPrompt(id),
      );
      const rewinds = typeof getHarness(id)?.rewindLastTurn === "function";
      expect(harnessCan(id, "rewind") !== "none", `${id} rewind`).toBe(rewinds);
    }
  });
});
