import { useMemo } from "react";
import { sessionWorkCwd } from "../../sessions/model/session";
import { gatewaySessionInput } from "../../gateway-connectors/model/sessionGateway";
import { useModelProviders } from "../../model-setup/model/modelProviders";
import { useOutboundCalls } from "../../settings/model/outboundCalls";
import {
  networkLog,
  privacyView,
  type PrivacySession,
} from "../model/privacyView";
import { PrivacySection, PrivateBadge } from "./PrivacySection";

export type PrivacyPanelSession = PrivacySession & { id?: string };

/** The privacy view for a session, recomputed when providers or switches change. */
export function usePrivacyView(session: PrivacyPanelSession) {
  const providers = useModelProviders();
  const outbound = useOutboundCalls();
  // Blocks change on every streamed token; only the network log reads them,
  // so the rest is keyed on the fields that decide the routes.
  const routeKey = JSON.stringify([
    session.id,
    session.harness,
    session.runtimeMode,
    session.cwd,
    session.worktreeCwd,
    session.model,
    session.modelProvider,
    session.providerAccountId,
    session.permissionsProfile,
    session.extraDirs,
    session.disabledMcpServers,
  ]);
  const routes = useMemo(() => {
    let gatewayServers: ReturnType<typeof gatewaySessionInput>["servers"] = [];
    try {
      gatewayServers = gatewaySessionInput(
        session,
        sessionWorkCwd(session),
      ).servers;
    } catch {
      gatewayServers = [];
    }
    return privacyView(
      { ...session, blocks: [] },
      { gatewayServers, outboundOn: (id) => outbound[id] !== false },
    );
    // providers: the model route reads the provider list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, providers, outbound]);
  const log = useMemo(() => networkLog(session.blocks), [session.blocks]);
  return useMemo(() => ({ ...routes, networkLog: log }), [routes, log]);
}

/** The side panel's "Sandbox and privacy" section for one session. */
export function SessionPrivacySection({
  session,
}: {
  session: PrivacyPanelSession;
}) {
  return <PrivacySection view={usePrivacyView(session)} />;
}

/** The Private mark for a session, or nothing. */
export function SessionPrivateBadge({
  session,
}: {
  session: PrivacyPanelSession;
}) {
  return <PrivateBadge view={usePrivacyView(session)} />;
}
