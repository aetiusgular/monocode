import { harnessCan } from "../../../integrations/harness/core/capabilities";
import { sessionProviderLocality } from "../../model-setup/model/sessionProvider";
import { modelTraits } from "../../model-traits/model/modelTraits";
import type { Block, Session } from "../../sessions/model/session";
import {
  isRelayedCloudModel,
  localityAccount,
  reportedRouteLocality,
} from "../../server-locality/model/reportedRoute";
import { knownHarnessModelRoute } from "../../server-locality/model/sessionServers";

/**
 * Gateway connectors on a local model (Mac test 1.3, the user's decision of
 * 12 Oct).
 *
 * Codex sends every tool of every connector that is on with every request,
 * so on a small local model eight connectors fill a 16k window before the
 * prompt. A new Codex chat on a local model route therefore starts with every
 * gateway connector off, and the user switches one on per chat. Claude Code
 * loads connector tools on demand, so its chats keep them on.
 *
 * The chat keeps the choice in `gatewayOn`: present means "off unless named
 * here". It is set when the first message is sent and saved with the chat,
 * so a chat keeps its state whatever happens to its model later. Chats from
 * before this change have no `gatewayOn` and keep their switches as they are.
 */

/** Context windows under this count as small when locality is not known. */
export const SMALL_CONTEXT_WINDOW = 32_768;

export type LocalDefaultSession = Pick<Session, "harness" | "model"> &
  Partial<
    Pick<
      Session,
      | "modelProvider"
      | "providerAccountId"
      | "gatewayOn"
      | "blocks"
      | "cwd"
      | "worktreeCwd"
    >
  >;

/**
 * Whether a chat's model route is local, or small enough to count as local:
 * the chat's provider (or its Codex account's) on loopback; when neither is
 * set, the route the chat's own Codex reported from its home (a wrapper
 * script home); when that is not known either, a context window under 32k
 * from Settings, Models or the catalog. An Ollama cloud model (`-cloud`) is
 * hosted.
 */
export function localModelRoute(session: LocalDefaultSession): boolean {
  if (!harnessCan(session.harness, "modelProvider")) return false;
  if (isRelayedCloudModel(session.model)) return false;
  const locality = sessionProviderLocality(session);
  if (locality === "local") return true;
  if (locality === "hosted") return false;
  const reported = knownHarnessModelRoute(
    session.harness,
    localityAccount(session),
    session.worktreeCwd || session.cwd || "",
  );
  const reportedLocality = reported ? reportedRouteLocality(reported) : null;
  if (reportedLocality === "local") return true;
  if (reportedLocality === "hosted") return false;
  const window = modelTraits(session.model).contextWindow;
  return window !== undefined && window < SMALL_CONTEXT_WINDOW;
}

function hasUserTurn(blocks: readonly Block[] | undefined): boolean {
  return !!blocks?.some((block) => block.role === "user" && !block.draft);
}

/**
 * The connectors a chat switched on under the local default, or undefined
 * when the default does not apply. A chat that has not sent a message yet
 * follows its current model route; after that, only what was saved counts.
 */
export function gatewayOnList(
  session: Partial<LocalDefaultSession> & Pick<LocalDefaultSession, "harness">,
): readonly string[] | undefined {
  if (session.gatewayOn) return session.gatewayOn;
  if (session.harness !== "codex" || !session.model) return undefined;
  if (!session.blocks || hasUserTurn(session.blocks)) return undefined;
  return localModelRoute({ ...session, model: session.model }) ? [] : undefined;
}

/**
 * The `gatewayOn` to save when a chat sends its first message, or undefined
 * when it has one already or the default does not apply.
 */
export function gatewayOnAtFirstTurn(
  session: Partial<LocalDefaultSession> & Pick<LocalDefaultSession, "harness">,
): string[] | undefined {
  if (session.gatewayOn || !session.blocks) return undefined;
  const on = gatewayOnList(session);
  return on ? [...on] : undefined;
}

/** The chat's list with one connector switched on or off. */
export function withGatewayOn(
  on: readonly string[],
  name: string,
  enabled: boolean,
): string[] {
  const rest = on.filter((entry) => entry !== name);
  return enabled ? [...rest, name] : rest;
}

const MAX_ON = 64;

/** A stored list: connector names only, bounded. An empty list is kept. */
export function sanitizeGatewayOn(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (out.length >= MAX_ON) break;
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (!name || name.length > 200 || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

export const LOCAL_DEFAULT_NOTE =
  "Off by default on a local model: each connector's tools are sent with every request.";
