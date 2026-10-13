import { describeCommand } from "../../owned-processes/model/ownedProcesses";
import type { PreviewCandidate } from "./launchConfig";

/**
 * #37: what the confirmation shows before a preview starts. Everything that
 * decides what runs is on it: the command as it would be typed, the folder,
 * the script a package manager runs with its pre and post scripts, the
 * environment, the port. Every value is shown in full, never cut: a launch
 * file is written by the project, not by the user, and a long harmless
 * prefix must not hide what follows. The view scrolls instead. The editor's
 * own values (#28) are not shown, as they are the user's. An `.npmrc` is
 * named, not shown: it can hold a registry token.
 */
export type PreviewConfirmText = {
  command: string;
  folder: string;
  script?: string;
  preScript?: string;
  postScript?: string;
  npmrc?: string;
  env: string[];
  port?: string;
  /** For a free port: the host MonoCode passes, and what it cannot ensure. */
  host?: string;
  source: string;
  warning: string;
};

export const PREVIEW_WARNING =
  "It runs this project's code with your full rights, outside the agent's sandbox, and reloads files as the agent edits them. While it runs, this chat does not count as sandboxed.";

/** Mac test 6.17: `npx serve .` listened on every interface. */
export const AUTO_PORT_HOST_NOTE =
  "MonoCode passes HOST=127.0.0.1. A server that ignores it may listen on every network interface.";

export function previewConfirmText(candidate: PreviewCandidate): PreviewConfirmText {
  return {
    command: describeCommand({ program: candidate.program, args: candidate.args }),
    folder: candidate.cwd ? `the project's ${candidate.cwd} folder` : "the project folder",
    ...(candidate.scriptBody ? { script: candidate.scriptBody } : {}),
    ...(candidate.preScript !== undefined ? { preScript: candidate.preScript } : {}),
    ...(candidate.postScript !== undefined ? { postScript: candidate.postScript } : {}),
    ...(candidate.npmrcHash
      ? {
          npmrc:
            "This project has an .npmrc, which npm reads when it runs a script. A change to it asks again.",
        }
      : {}),
    env: Object.keys(candidate.env)
      .sort()
      .map((name) => `${name}=${candidate.env[name]}`),
    ...(candidate.autoPort
      ? { port: "A free port, passed as PORT" }
      : candidate.port
        ? { port: String(candidate.port) }
        : {}),
    ...(candidate.autoPort ? { host: AUTO_PORT_HOST_NOTE } : {}),
    source:
      candidate.source === "launch.json"
        ? `.claude/launch.json, "${candidate.label}"`
        : `the "${candidate.args[1] ?? ""}" script in package.json`,
    warning: PREVIEW_WARNING,
  };
}
