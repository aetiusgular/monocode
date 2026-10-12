import {
  bindCodexSession,
  cancelCodexTurn,
  compactCodexContext,
  rewindCodexLastTurn,
  forgetCodexSession,
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
import { listCodexMcpServers } from "./codexMcpServers";
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
// [lane-1] imports
import {
  listCodexBackgroundTasks as listCodexBackgroundTasks_l1,
  stopCodexBackgroundTask as stopCodexBackgroundTask_l1,
} from "./codexBackground";
import { forkCodexSession_l1 } from "./codex";
import {
  listCodexSessions as listCodexSessions_l1,
  readCodexSessionTurns as readCodexSessionTurns_l1,
} from "./codexSessions";
// [lane-2] imports
// [lane-3] imports
// [lane-4] imports
// [lane-5] imports

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
  // [lane-1] adapter
  listBackgroundTasks: listCodexBackgroundTasks_l1,
  stopBackgroundTask: stopCodexBackgroundTask_l1,
  forkSession: (input) =>
    forkCodexSession_l1({ source: input.source, boundary: input.boundary }),
  listSessions: listCodexSessions_l1,
  readSessionTurns: readCodexSessionTurns_l1,
  // [lane-2] adapter
  // [lane-3] adapter
  // [lane-4] adapter
  // [lane-5] adapter
};

let registered = false;

export function ensureCodexRegistered(): void {
  if (registered && getHarness("codex") === codexAdapter) return;
  registerHarness(codexAdapter);
  registered = true;
}
