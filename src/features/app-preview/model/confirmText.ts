import { describeCommand } from "../../owned-processes/model/ownedProcesses";
import type { PreviewCandidate } from "./launchConfig";

/**
 * #37: what the confirmation shows before a preview starts. Everything that
 * decides what runs is on it: the command as it would be typed, the folder,
 * the script a package manager runs, the environment, the port. A value is
 * shown in full, because a launch file is written by the project, not by the
 * user; the editor's own values (#28) are not shown, as they are the user's.
 */
export type PreviewConfirmText = {
  command: string;
  folder: string;
  script?: string;
  env: string[];
  port?: string;
  source: string;
  warning: string;
};

const MAX_SHOWN = 400;

function cut(value: string): string {
  return value.length > MAX_SHOWN ? `${value.slice(0, MAX_SHOWN - 1)}…` : value;
}

export const PREVIEW_WARNING =
  "It runs this project's code with your full rights, outside the agent's sandbox, and reloads files as the agent edits them. While it runs, this chat does not count as sandboxed.";

export function previewConfirmText(candidate: PreviewCandidate): PreviewConfirmText {
  return {
    command: cut(
      describeCommand({ program: candidate.program, args: candidate.args }),
    ),
    folder: candidate.cwd ? `the project's ${candidate.cwd} folder` : "the project folder",
    ...(candidate.scriptBody ? { script: cut(candidate.scriptBody) } : {}),
    env: Object.keys(candidate.env)
      .sort()
      .map((name) => cut(`${name}=${candidate.env[name]}`)),
    ...(candidate.autoPort
      ? { port: "A free port, passed as PORT" }
      : candidate.port
        ? { port: String(candidate.port) }
        : {}),
    source:
      candidate.source === "launch.json"
        ? `.claude/launch.json, "${candidate.label}"`
        : `the "${candidate.args[1] ?? ""}" script in package.json`,
    warning: PREVIEW_WARNING,
  };
}
