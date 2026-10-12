import type {
  HarnessLaunchMcpServer,
  HarnessToolAccess,
} from "../../../integrations/harness/core/types";
import {
  chatDisabledSkills,
  harnessDisabledSkills,
} from "../../chat-skills/model/chatSkills";
import { harnessDisabledPlugins } from "../../claude-plugins/model/chatPlugins";
import type { Session, ToolAccess } from "../../sessions/model/session";
import {
  harnessToolAccess,
  toolLabel,
  toolRuleCount,
} from "../../tool-access/model/toolAccess";
import {
  gatewaySessionInput,
  gatewaySwitchedOff,
} from "../../gateway-connectors/model/sessionGateway";
import { harnessDisabledMcpServers } from "./connectors";
import { harnessExtraDirs } from "./extraDirs";
import { sanitizeModelProvider } from "../../model-setup/model/modelProvider";

/** The session fields a harness turn's composer tools are built from. */
type SessionTools = Pick<
  Session,
  | "harness"
  | "extraDirs"
  | "disabledMcpServers"
  | "toolAccess"
  | "disabledSkills"
  | "disabledPlugins"
  | "modelProvider"
> &
  // The chat, for its claude.ai connectors switched back on over a Docker
  // gateway copy.
  Partial<Pick<Session, "id">>;

/**
 * A session's composer tools in the shape a harness turn takes. Every call
 * that can start a harness process (send, rewind, compact, handoff) must pass
 * the same value: Claude Code and Codex reopen the conversation whenever these
 * launch inputs differ.
 */
export function sessionToolsInput(
  session: SessionTools,
  workCwd: string,
): {
  extraDirs?: string[];
  disabledMcpServers?: string[];
  gatewayConnectors?: HarnessLaunchMcpServer[];
  toolAccess?: HarnessToolAccess;
  disabledSkills?: string[];
  disabledPlugins?: string[];
  modelProvider?: string;
} {
  const extraDirs = harnessExtraDirs(
    session.harness,
    session.extraDirs,
    workCwd,
  );
  // Docker gateway connectors are added at launch. One switched off for the
  // chat is simply not added, so its name never reaches the harness as a
  // switch. claude.ai copies of a connector the gateway serves are off by
  // default for Claude Code chats.
  const gateway = gatewaySessionInput(session, workCwd);
  const disabledMcpServers = harnessDisabledMcpServers(session.harness, [
    ...(session.disabledMcpServers ?? []).filter(
      (name) => !gateway.names.has(name),
    ),
    ...gateway.defaultOff,
  ]);
  const gatewayConnectors = gateway.servers;
  const toolAccess = harnessToolAccess(session.harness, session.toolAccess);
  const disabledSkills = harnessDisabledSkills(
    session.harness,
    session.disabledSkills,
  );
  const disabledPlugins = harnessDisabledPlugins(
    session.harness,
    session.disabledPlugins,
  );
  return {
    ...(extraDirs ? { extraDirs } : {}),
    ...(disabledMcpServers ? { disabledMcpServers } : {}),
    ...(gatewayConnectors.length > 0 ? { gatewayConnectors } : {}),
    ...(toolAccess ? { toolAccess } : {}),
    ...(disabledSkills ? { disabledSkills } : {}),
    ...(disabledPlugins ? { disabledPlugins } : {}),
    // Carried with no effect until the provider picker uses it.
    ...(session.modelProvider ? { modelProvider: session.modelProvider } : {}),
  };
}

/** The session with its extra folders replaced; an empty list clears them. */
export function withExtraDirs<T extends Pick<Session, "extraDirs">>(
  session: T,
  dirs: string[],
): T {
  return { ...session, extraDirs: dirs.length > 0 ? dirs : undefined };
}

/** The session with its switched-off MCP servers replaced, likewise. */
export function withDisabledMcpServers<
  T extends Pick<Session, "disabledMcpServers">,
>(session: T, names: string[]): T {
  return {
    ...session,
    disabledMcpServers: names.length > 0 ? names : undefined,
  };
}

/**
 * Per-chat settings the composer's plus menu changes through one handler.
 * A key that is present replaces that setting; an empty value clears it.
 */
export type SessionToolsPatch = {
  toolAccess?: ToolAccess;
  disabledSkills?: string[];
  disabledPlugins?: string[];
  /** A provider id; an empty string returns the chat to the default. */
  modelProvider?: string;
};

/** The session with a plus-menu change applied. */
export function withSessionToolsPatch<
  T extends Pick<
    Session,
    "toolAccess" | "disabledSkills" | "disabledPlugins" | "modelProvider"
  >,
>(session: T, patch: SessionToolsPatch): T {
  let next = session;
  if (patch.toolAccess) {
    next = {
      ...next,
      toolAccess:
        Object.keys(patch.toolAccess).length > 0 ? patch.toolAccess : undefined,
    };
  }
  if (patch.disabledSkills) {
    next = {
      ...next,
      disabledSkills:
        patch.disabledSkills.length > 0 ? patch.disabledSkills : undefined,
    };
  }
  if (patch.disabledPlugins) {
    next = {
      ...next,
      disabledPlugins:
        patch.disabledPlugins.length > 0 ? patch.disabledPlugins : undefined,
    };
  }
  if (patch.modelProvider !== undefined) {
    next = {
      ...next,
      modelProvider: sanitizeModelProvider(patch.modelProvider),
    };
  }
  return next;
}

/**
 * The tools a turn is sent with, in a few words, for a composer too small for
 * the folder chips and the connectors badge. `title` lists each folder's path,
 * each switched-off server, each tool rule, each switched-off skill and each
 * switched-off plugin. Null when a turn is sent with none of them.
 */
export function sessionToolsSummary(
  session: SessionTools,
  workCwd: string,
): { label: string; title: string } | null {
  const {
    extraDirs = [],
    disabledMcpServers: passed = [],
    toolAccess,
    disabledPlugins = [],
  } = sessionToolsInput(session, workCwd);
  // Gateway connectors switched off are left out at launch rather than
  // passed as switches; they are still off.
  const disabledMcpServers = [
    ...passed,
    ...gatewaySwitchedOff(session.harness, session.disabledMcpServers),
  ];
  const parts: string[] = [];
  const lines: string[] = [];
  if (extraDirs.length > 0) {
    parts.push(
      `${extraDirs.length} ${extraDirs.length === 1 ? "folder" : "folders"}`,
    );
    lines.push("Extra folders:", ...extraDirs);
  }
  if (disabledMcpServers.length > 0) {
    parts.push(`${disabledMcpServers.length} off`);
    lines.push(`Connectors off: ${disabledMcpServers.join(", ")}`);
  }
  const rules = toolRuleCount(toolAccess);
  if (rules > 0) {
    parts.push(`${rules} ${rules === 1 ? "tool rule" : "tool rules"}`);
    const always = toolAccess?.always ?? [];
    const never = toolAccess?.never ?? [];
    if (always.length > 0) {
      lines.push(`Always allow: ${always.map(toolLabel).join(", ")}`);
    }
    if (never.length > 0) {
      lines.push(`Never allow: ${never.map(toolLabel).join(", ")}`);
    }
  }
  // Not a harness input everywhere, but a turn is prepared without them: a
  // switched-off skill's `/name` is not expanded on any harness that has the
  // switches.
  const skillsOff = chatDisabledSkills(session.harness, session.disabledSkills);
  if (skillsOff.length > 0) {
    parts.push(
      `${skillsOff.length} ${skillsOff.length === 1 ? "skill" : "skills"} off`,
    );
    lines.push(`Skills off: ${skillsOff.join(", ")}`);
  }
  if (disabledPlugins.length > 0) {
    parts.push(
      `${disabledPlugins.length} ${disabledPlugins.length === 1 ? "plugin" : "plugins"} off`,
    );
    lines.push(`Plugins off: ${disabledPlugins.join(", ")}`);
  }
  return parts.length > 0
    ? { label: parts.join(" · "), title: lines.join("\n") }
    : null;
}
