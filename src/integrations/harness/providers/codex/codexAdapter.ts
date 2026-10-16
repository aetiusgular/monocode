import {
  bindCodexSession,
  cancelCodexTurn,
  compactCodexContext,
  rewindCodexLastTurn,
  forgetCodexSession,
  forkCodexSession,
  keepCodexQuestionOpen,
  respondCodexApproval,
  respondCodexQuestion,
  sendCodexTurn,
  setCodexToolAccess,
  steerCodexTurn,
  stopCodexSession,
} from "./codex";
import {
  generateCodexBranchName,
  generateCodexCommitMessage,
  generateCodexPrContent,
} from "./codexGit";
import { refreshCodexCatalog } from "./codexCatalog";
import { listCodexMcpServers, readCodexConfigReport } from "./codexMcpServers";
import { registerHarnessConfigProbe } from "../../../../features/server-locality/model/sessionServers";
import { generateCodexSessionTitle } from "./codexTitle";
import {
  runCodexTextPrompt,
  stopCodexTextPrompt,
  warmupCodexText,
} from "./codexText";
import {
  getHarness,
  registerHarness,
  type HarnessAdapter,
} from "../../core/registry";
import {
  listCodexBackgroundTasks,
  stopCodexBackgroundTask,
} from "./codexBackground";
import {
  listCodexSessions,
  readCodexSessionTurns,
} from "./codexSessions";

export const codexAdapter: HarnessAdapter = {
  id: "codex",
  live: true,
  sendTurn: sendCodexTurn,
  compactContext: compactCodexContext,
  rewindLastTurn: rewindCodexLastTurn,
  steerTurn: steerCodexTurn,
  cancelTurn: cancelCodexTurn,
  respondApproval: respondCodexApproval,
  respondQuestion: respondCodexQuestion,
  keepQuestionOpen: keepCodexQuestionOpen,
  setToolAccess: setCodexToolAccess,
  stopSession: stopCodexSession,
  forgetSession: forgetCodexSession,
  bindSession: bindCodexSession,
  refreshCatalog: refreshCodexCatalog,
  generateTitle: generateCodexSessionTitle,
  generateCommitMessage: generateCodexCommitMessage,
  generatePrContent: generateCodexPrContent,
  generateBranchName: generateCodexBranchName,
  warmupText: warmupCodexText,
  runTextPrompt: runCodexTextPrompt,
  stopTextPrompt: stopCodexTextPrompt,
  listMcpServers: listCodexMcpServers,
  listBackgroundTasks: listCodexBackgroundTasks,
  stopBackgroundTask: stopCodexBackgroundTask,
  forkSession: (input) =>
    forkCodexSession({ source: input.source, boundary: input.boundary }),
  listSessions: listCodexSessions,
  readSessionTurns: readCodexSessionTurns,
};

let registered = false;

export function ensureCodexRegistered(): void {
  if (registered && getHarness("codex") === codexAdapter) return;
  registerHarness(codexAdapter);
  // 5.6: the session's own Codex says which provider it runs on.
  registerHarnessConfigProbe("codex", (input) => readCodexConfigReport(input));
  registered = true;
}
