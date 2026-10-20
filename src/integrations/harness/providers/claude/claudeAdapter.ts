import {
  attachClaudeSession,
  bindClaudeSession,
  cancelClaudeTurn,
  compactClaudeContext,
  forgetClaudeSession,
  forkClaudeSession,
  respondClaudeApproval,
  respondClaudeQuestion,
  restoreClaudeTaskLists,
  rewindClaudeLastTurn,
  sendClaudeTurn,
  setClaudeToolAccess,
  steerClaudeTurn,
  stopClaudeBackgroundTask,
  stopClaudeSession,
} from "./claude";
import { refreshClaudeCatalog } from "./claudeCatalog";
import {
  generateClaudeBranchName,
  generateClaudeCommitMessage,
  generateClaudePrContent,
} from "./claudeGit";
import { generateClaudeSessionTitle } from "./claudeTitle";
import {
  runClaudeTextPrompt,
  stopClaudeTextPrompt,
  warmupClaudeText,
} from "./claudeText";
import { registerHarness, type HarnessAdapter } from "../../core/registry";
import { listClaudeSessions } from "./claudeSessions";

export const claudeAdapter: HarnessAdapter = {
  id: "claude",
  live: true,
  sendTurn: sendClaudeTurn,
  compactContext: compactClaudeContext,
  rewindLastTurn: rewindClaudeLastTurn,
  steerTurn: steerClaudeTurn,
  cancelTurn: cancelClaudeTurn,
  respondApproval: respondClaudeApproval,
  respondQuestion: respondClaudeQuestion,
  setToolAccess: setClaudeToolAccess,
  attachSession: attachClaudeSession,
  stopSession: stopClaudeSession,
  forgetSession: forgetClaudeSession,
  bindSession: bindClaudeSession,
  restoreTaskLists: restoreClaudeTaskLists,
  refreshCatalog: refreshClaudeCatalog,
  generateTitle: generateClaudeSessionTitle,
  generateCommitMessage: generateClaudeCommitMessage,
  generatePrContent: generateClaudePrContent,
  generateBranchName: generateClaudeBranchName,
  warmupText: warmupClaudeText,
  runTextPrompt: runClaudeTextPrompt,
  stopTextPrompt: stopClaudeTextPrompt,
  stopBackgroundTask: stopClaudeBackgroundTask,
  forkSession: (input) =>
    forkClaudeSession({
      sourceSessionId: input.source.sessionId,
      newSessionId: input.newSessionId,
      providerSessionId: input.providerSessionId,
      cwd: input.source.cwd,
      providerAccountId: input.source.providerAccountId,
      boundary: input.boundary,
    }),
  listSessions: listClaudeSessions,
};

let registered = false;

export function ensureClaudeRegistered(): void {
  if (registered) return;
  registerHarness(claudeAdapter);
  registered = true;
}
