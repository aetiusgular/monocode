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
