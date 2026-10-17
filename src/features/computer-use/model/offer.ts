import { harnessCan } from "../../../integrations/harness/core/capabilities";
import type { HarnessLaunchMcpServer } from "../../../integrations/harness/core/types";
import { modelReadsImages } from "../../model-traits/model/modelTraits";
import type { Session } from "../../sessions/model/session";
import { chatSwitch, type ChatSwitch } from "./chatSwitch";

/**
 * The MCP server name a chat's harness sees for computer use. Reserved: a
 * gateway connector with the same name is left out of that chat, so an
 * outside server can never stand in for this one.
 */
export const COMPUTER_USE_SERVER = "monocode_computer_use";

/** The argument the desktop executable takes to run as the chat's bridge. */
export const COMPUTER_USE_CLI_ARG = "computer-use-mcp";

export type OfferSession = Pick<Session, "harness" | "model"> &
  Partial<Pick<Session, "id">>;

export type OfferBlock =
  /** Computer use runs only on macOS. */
  | "platform"
  /** The harness takes no MCP servers from MonoCode at start (F1 `mcpInject`). */
  | "harness"
  /** The model is not known to read images, and no override is set. */
  | "vision"
  /** The desktop executable's path is not known yet. */
  | "app";

export type Offer =
  | { offered: true; switch: ChatSwitch }
  | { offered: false; switch: ChatSwitch; block?: OfferBlock };

export type OfferContext = {
  isMac: boolean;
  /** The desktop executable, from `app_cli_path`. */
  cliPath?: string;
  /** For tests; the stored switch otherwise. */
  switchFor?: (chatId: string | undefined) => ChatSwitch;
  /** For tests; the model's vision trait otherwise. */
  readsImages?: (model: string) => boolean;
};

/**
 * Whether computer use can be offered to this chat at all, ignoring the
 * chat's own switch: macOS, a harness MonoCode passes MCP servers to, and a
 * model that reads images (or the chat's override).
 */
export function computerUseBlock(
  session: OfferSession,
  context: OfferContext,
  sw: ChatSwitch = (context.switchFor ?? chatSwitch)(session.id),
): OfferBlock | undefined {
  if (!context.isMac) return "platform";
  if (!harnessCan(session.harness, "mcpInject")) return "harness";
  const reads = context.readsImages ?? modelReadsImages;
  if (!sw.withoutVision && !(session.model && reads(session.model))) {
    return "vision";
  }
  if (!context.cliPath) return "app";
  return undefined;
}

/** Whether this chat's harness gets the computer-use server. */
export function computerUseOffer(
  session: OfferSession,
  context: OfferContext,
): Offer {
  const sw = (context.switchFor ?? chatSwitch)(session.id);
  const block = computerUseBlock(session, context, sw);
  if (block) return { offered: false, switch: sw, block };
  if (!sw.on) return { offered: false, switch: sw };
  return { offered: true, switch: sw };
}

/**
 * The launch entry for the chat's computer-use server: the desktop
 * executable as a stdio bridge. It carries no secret: the bridge reads the
 * chat's endpoint and token from the environment MonoCode gives the harness
 * process, so nothing on a command line names them.
 */
export function computerUseLaunchServer(
  session: OfferSession,
  context: OfferContext,
): HarnessLaunchMcpServer | null {
  if (!computerUseOffer(session, context).offered || !context.cliPath) {
    return null;
  }
  return {
    name: COMPUTER_USE_SERVER,
    command: context.cliPath,
    args: [COMPUTER_USE_CLI_ARG],
  };
}

/**
 * The chat's launch servers with computer use added: any other server under
 * the reserved name is dropped, and the bridge goes last.
 */
export function withComputerUseServer(
  servers: readonly HarnessLaunchMcpServer[],
  server: HarnessLaunchMcpServer | null,
): HarnessLaunchMcpServer[] {
  const others = servers.filter(
    (entry) => entry.name !== COMPUTER_USE_SERVER,
  );
  return server ? [...others, server] : others;
}
