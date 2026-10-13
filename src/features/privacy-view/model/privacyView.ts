import type { HarnessLaunchMcpServer } from "../../../integrations/harness/core/types";
import { harnessCan } from "../../../integrations/harness/core/capabilities";
import {
  RUNTIME_MODE_LABEL,
  sessionWorkCwd,
  type Block,
  type Session,
} from "../../sessions/model/session";
import {
  isLocal,
  localityAccount,
  localityReportStale,
  modelRoutePart,
  sessionIsLocal,
  sessionLocalityParts,
  type Locality,
} from "../../server-locality/model/locality";
import { knownHarnessModelRoute } from "../../server-locality/model/sessionServers";
import { serverLocality } from "../../server-locality/model/serverLocality";
import { findModelProvider } from "../../model-setup/model/modelProviders";
import { urlHost } from "../../model-setup/model/loopback";
import { sessionModelProvider } from "../../model-setup/model/sessionProvider";
import { sanitizePermissionsProfile } from "../../model-setup/model/permissionsProfile";
import {
  OUTBOUND_CALLS,
  type OutboundCallId,
} from "../../settings/model/outboundCalls";

export type PrivacySession = Pick<
  Session,
  "harness" | "runtimeMode" | "cwd" | "worktreeCwd" | "blocks"
> &
  Partial<
    Pick<
      Session,
      | "model"
      | "modelProvider"
      | "providerAccountId"
      | "permissionsProfile"
      | "extraDirs"
      | "disabledMcpServers"
      | "disabledSkills"
      | "gatewayOn"
    >
  >;

export type Destination = {
  kind: "model" | "connector" | "monocode";
  label: string;
  detail?: string;
  locality: Locality;
};

export type NetworkDecision = {
  blockId: string;
  host: string;
  protocol: string;
  decided?: "allow" | "deny" | "cancelled";
};

export type SandboxView = {
  /** Only Codex runs commands inside a sandbox. */
  sandboxed: boolean;
  mode: string;
  /** Codex permissions profile that replaces the mode's sandbox. */
  profile?: string;
  writable: string;
  network: string;
  /**
   * #37: something MonoCode itself runs for this chat outside any sandbox,
   * such as a preview server. Its presence makes the chat unsandboxed.
   */
  outside?: string;
};

export type PrivacyView = {
  sandbox: SandboxView;
  destinations: Destination[];
  networkLog: NetworkDecision[];
  /** Model, harness home and every enabled tool are local. */
  private: boolean;
  /** Why the session is not private, short, for a tooltip. */
  notPrivateBecause?: string;
};

const MAX_LOG = 50;

export function sandboxView(session: PrivacySession): SandboxView {
  const sandboxed = harnessCan(session.harness, "sandboxed");
  const mode = RUNTIME_MODE_LABEL[session.runtimeMode];
  if (!sandboxed)
    return {
      sandboxed,
      mode,
      writable: "Everything your account can write",
      network: "Open. This agent has no sandbox",
    };
  const profile = sanitizePermissionsProfile(session.permissionsProfile);
  if (profile && session.runtimeMode !== "full-access")
    return {
      sandboxed,
      mode,
      profile,
      writable: `Set by the profile ${profile}. Plan turns stay read only`,
      network: `Set by the profile ${profile}`,
    };
  const workCwd = sessionWorkCwd(session);
  const extra = session.extraDirs?.length
    ? `, plus ${session.extraDirs.length} added folder${session.extraDirs.length === 1 ? "" : "s"}`
    : "";
  switch (session.runtimeMode) {
    case "supervised":
      return {
        sandboxed,
        mode,
        writable: "Nothing without your approval",
        network: "Off. Each request asks you",
      };
    case "auto-accept-edits":
    case "auto":
      return {
        sandboxed,
        mode,
        writable: `${workCwd}${extra}, and temporary folders`,
        network: "Off. Each request asks you",
      };
    case "full-access":
      return {
        sandboxed: false,
        mode,
        writable: "Everything your account can write",
        network: "Open",
      };
  }
}

function modelDestination(session: PrivacySession): Destination {
  if (session.harness === "claude")
    return {
      kind: "model",
      label: "Model",
      detail: "Anthropic, through Claude Code",
      locality: "hosted",
    };
  if (!harnessCan(session.harness, "modelProvider"))
    return {
      kind: "model",
      label: "Model",
      detail: "Set by the harness's own config, not read by MonoCode",
      locality: "unknown",
    };
  const id = sessionModelProvider(session);
  const provider = findModelProvider(id);
  const route = modelRoutePart(session);
  if (id) {
    return {
      kind: "model",
      label: "Model",
      detail: provider
        ? `${provider.label} (${urlHost(provider.baseUrl) ?? provider.baseUrl})`
        : `${id}, not set up in MonoCode`,
      locality: route.locality,
    };
  }
  // 5.6: the session's own Codex said which provider its home names.
  const reported = knownHarnessModelRoute(
    session.harness,
    localityAccount(session),
    sessionWorkCwd(session),
  );
  if (reported) {
    const url = Object.prototype.hasOwnProperty.call(
      reported.baseUrls,
      reported.provider,
    )
      ? reported.baseUrls[reported.provider]
      : undefined;
    const host = urlHost(url);
    return {
      kind: "model",
      label: "Model",
      detail: `${reported.provider}${host ? ` (${host})` : ""}, from the harness's own config`,
      locality: route.locality,
    };
  }
  return {
    kind: "model",
    label: "Model",
    detail: "Set by the harness's own config, not reported to MonoCode yet",
    locality: "unknown",
  };
}

/** Every network approval in the transcript, newest first. */
export function networkLog(blocks: readonly Block[]): NetworkDecision[] {
  const log: NetworkDecision[] = [];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    const network = block.approval?.network;
    if (!network) continue;
    log.push({
      blockId: block.id,
      host: network.host,
      protocol: network.protocol,
      decided: block.approval?.decided,
    });
    if (log.length >= MAX_LOG) break;
  }
  return log;
}

export function privacyView(
  session: PrivacySession,
  input: {
    /** Gateway connectors this chat starts with. */
    gatewayServers?: readonly HarnessLaunchMcpServer[];
    /** MonoCode's own outbound calls that are switched on. */
    outboundOn?: (id: OutboundCallId) => boolean;
    /** #37: a preview server MonoCode runs for this chat. */
    previewServer?: { command: string };
  } = {},
): PrivacyView {
  const destinations: Destination[] = [modelDestination(session)];
  for (const server of input.gatewayServers ?? []) {
    destinations.push({
      kind: "connector",
      label: server.name,
      detail: "Docker gateway connector",
      // One rule for every place a connector's mark is shown (12.8): the
      // catalog facts are found by the profile in its arguments.
      locality: serverLocality({
        name: server.name,
        command: server.command,
        args: server.args,
      }),
    });
  }
  // MonoCode's own calls are listed, but they carry no transcript to a
  // model, so they never end Private (Mac finding 2.23).
  for (const call of OUTBOUND_CALLS) {
    if (!input.outboundOn || !input.outboundOn(call.id)) continue;
    destinations.push({
      kind: "monocode",
      label: call.label,
      detail: `MonoCode itself, not this chat: ${call.hosts.join(", ")}`,
      locality: "hosted",
    });
  }

  const sessionDestinations = destinations.filter(
    (item) => item.kind !== "monocode",
  );
  // Name what ended Private: a hosted part before one that is only unknown.
  const away =
    sessionDestinations.find((item) => item.locality === "hosted") ??
    sessionDestinations.find((item) => !isLocal(item.locality));
  // The same rule memory and the other gates use: model route, harness home
  // and every enabled tool local (sessionIsLocal), read from a report no
  // older than a minute (sessionLocalityNow, security fix R8).
  const local = isLocal(sessionIsLocal(session));
  const stale = local && localityReportStale(session);
  const isPrivate = local && !stale && !away;
  let notPrivateBecause: string | undefined;
  if (!isPrivate) {
    const part = away
      ? undefined
      : sessionLocalityParts(session).find((item) => !isLocal(item.locality));
    notPrivateBecause = away
      ? `${away.kind === "model" ? "its model" : away.label} ${away.locality === "hosted" ? "is hosted" : "is not known to be local"}`
      : part
        ? `${part.kind === "model" ? "its model" : part.label} ${part.locality === "hosted" ? "is hosted" : "is not known to be local"}`
        : stale
          ? "What its harness reported about its model and tools is more than a minute old"
          : "Its model, home or tools are not all known to be local";
  }
  const sandbox = sandboxView(session);
  return {
    sandbox: input.previewServer
      ? {
          ...sandbox,
          sandboxed: false,
          outside: `MonoCode runs a preview server for this chat (${input.previewServer.command}). It runs the project's code with your full rights and reloads as files change.`,
        }
      : sandbox,
    destinations,
    networkLog: networkLog(session.blocks),
    private: isPrivate,
    ...(notPrivateBecause ? { notPrivateBecause } : {}),
  };
}
