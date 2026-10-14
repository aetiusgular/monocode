import { newSession, type Session } from "../../sessions/model/session";

/**
 * The new chat "New chat with these" opens (finding 2.2): the same project,
 * harness, model, settings and account as the chat it came from, and every
 * switch that narrows what that chat can do or reach. Nothing that widens it
 * is carried.
 *
 * Carried, because each one narrows or keeps the chat where the user put it:
 * - `worktreeCwd` and `branch`: the source chat's own checkout, not whatever
 *   checkout the project has in focus. Left out when that checkout was removed.
 * - `providerAccountId`, `modelProvider`: the same account and model route,
 *   so a chat on a local model does not move to a hosted one.
 * - `disabledMcpServers`, `disabledSkills`, `disabledPlugins`: what the user
 *   switched off stays off.
 * - `gatewayOn`: under the local default, only the connectors named here are
 *   on, so the list keeps the rest off.
 * - `toolAccess`: "never" rules only.
 * - `permissionsProfile`: the named profile the user chose for this chat.
 *
 * Left out, because each one widens or belongs to the old conversation:
 * - `toolAccess` "always" rules and allow rules for one command: approvals
 *   granted in the old chat.
 * - `extraDirs`: extra folders the agent may write in.
 * - the transcript, provider conversation, queue, cards and turn state.
 */
export function newChatLike(source: Session): Session {
  const fresh = newSession(
    source.harness,
    source.cwd,
    source.model,
    source.runtimeMode,
    source.modelSettings,
  );
  const never = Object.fromEntries(
    Object.entries(source.toolAccess ?? {}).filter(
      ([, rule]) => rule === "never",
    ),
  );
  const checkout =
    source.worktreeCwd && !source.worktreeRemoved
      ? {
          worktreeCwd: source.worktreeCwd,
          ...(source.branch ? { branch: source.branch } : {}),
        }
      : {};
  return {
    ...fresh,
    ...checkout,
    ...(source.providerAccountId
      ? { providerAccountId: source.providerAccountId }
      : {}),
    ...(source.modelProvider ? { modelProvider: source.modelProvider } : {}),
    ...(source.disabledMcpServers?.length
      ? { disabledMcpServers: [...source.disabledMcpServers] }
      : {}),
    ...(source.disabledSkills?.length
      ? { disabledSkills: [...source.disabledSkills] }
      : {}),
    ...(source.disabledPlugins?.length
      ? { disabledPlugins: [...source.disabledPlugins] }
      : {}),
    ...(source.gatewayOn ? { gatewayOn: [...source.gatewayOn] } : {}),
    ...(Object.keys(never).length ? { toolAccess: never } : {}),
    ...(source.permissionsProfile
      ? { permissionsProfile: source.permissionsProfile }
      : {}),
  };
}
