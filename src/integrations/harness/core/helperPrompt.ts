/**
 * F6: helper prompts follow the session.
 *
 * Titles, commit messages, PR text and branch names run on the session that
 * owns the work: its harness, its account, and a model that account has.
 * A harness's cheap helper model is used only when that harness's live
 * catalog lists it. Otherwise the session's own model is used, so a local
 * Codex home is never asked for a hosted model it does not have.
 *
 * A harness with no isolated text prompt gets no helper at all: the content
 * is never sent to a different harness instead. PR text falls back to a
 * deterministic summary of the commit range.
 */
import type {
  HarnessId,
  Session,
} from "../../../features/sessions/model/session";
import { sessionWorkCwd } from "../../../features/sessions/model/session";
import {
  hasLiveCatalog,
  modelsFor,
  nativeModelId,
} from "../../../features/sessions/model/models";
import type { AgentModel } from "../../../features/sessions/model/models";
import { modelTimeoutFactor } from "../../../features/model-traits/model/modelTraits";
import { harnessCan } from "./capabilities";
import { canRunHarnessTextPrompt, runHarnessTextPrompt } from "./registry";
import {
  gitRangeContext,
  gitStagedContext,
} from "../../../platform/tauri/fs";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  formatCommitMessage,
  parseBranchName,
  parseCommitMessage,
  parsePrContent,
  type PrContent,
} from "../../../features/source-control/model/gitText";
import { prContentFromRange } from "../../../features/source-control/model/prFallback";
import {
  buildThreadTitlePrompt,
  parseGeneratedSessionTitle,
  type GeneratedSessionTitle,
} from "../../../features/sessions/model/sessionTitle";
import { pathKey } from "../../../shared/lib/paths";
import {
  selectedProviderAccountId,
  supportsProviderAccounts,
} from "../../../features/providers/model/providerAccounts";

/** The session a helper prompt runs for. */
export type HelperRoute = {
  kind: "route";
  harness: HarnessId;
  providerAccountId?: string;
  /** The session's model id, as stored on the session. */
  modelId?: string;
  modelSettings?: Record<string, string>;
  sessionId?: string;
  /** The session's model provider, where the harness records one (#32). */
  modelProvider?: string;
};

/** A bare harness id keeps the old behaviour for callers with no session. */
export type HelperTarget = HarnessId | HelperRoute;

export const TITLE_TIMEOUT_MS = 45_000;
export const GIT_TIMEOUT_MS = 90_000;

/** Cheap helper models by harness. Only used when the live catalog lists one. */
const CHEAP_MODEL: Partial<Record<HarnessId, RegExp>> = {
  codex: /5\.6-luna/i,
  claude: /haiku/i,
};

/**
 * Harnesses whose built-in list cannot be trusted to match the account:
 * a Codex home may run any provider, so only its live catalog counts.
 */
const NEEDS_LIVE_CATALOG: ReadonlySet<HarnessId> = new Set<HarnessId>([
  "codex",
]);

export function isHelperRoute(target: unknown): target is HelperRoute {
  return (
    typeof target === "object" &&
    target !== null &&
    (target as { kind?: unknown }).kind === "route" &&
    typeof (target as { harness?: unknown }).harness === "string"
  );
}

export function helperHarness(target: HelperTarget | undefined): HarnessId | undefined {
  if (target === undefined) return undefined;
  return isHelperRoute(target) ? target.harness : target;
}

type RouteSession = Pick<Session, "harness" | "model"> &
  Partial<
    Pick<Session, "id" | "providerAccountId" | "cwd" | "modelSettings" | "modelProvider">
  >;

/**
 * The account a session's turns run on: its own, else the project's
 * selection, the same way a turn resolves it in App.
 */
function routeAccount(session: RouteSession): string | undefined {
  if (!supportsProviderAccounts(session.harness)) return undefined;
  return (
    session.providerAccountId ??
    selectedProviderAccountId(session.harness, session.cwd)
  );
}

export function helperRouteForSession(session: RouteSession): HelperRoute {
  const providerAccountId = routeAccount(session);
  return {
    kind: "route",
    harness: session.harness,
    ...(providerAccountId ? { providerAccountId } : {}),
    ...(session.model ? { modelId: session.model } : {}),
    ...(session.modelSettings && Object.keys(session.modelSettings).length
      ? { modelSettings: session.modelSettings }
      : {}),
    ...(session.id ? { sessionId: session.id } : {}),
    ...(session.modelProvider ? { modelProvider: session.modelProvider } : {}),
  };
}

type CheckoutSession = RouteSession &
  Pick<Session, "id" | "cwd"> &
  Partial<Pick<Session, "worktreeCwd" | "workspaceMode">>;

/**
 * The session that owns a checkout: the active one if it works there, else
 * the first open session whose working folder is that checkout. Undefined
 * when no open session works there.
 */
export function helperRouteForCheckout(
  sessions: readonly CheckoutSession[],
  cwd: string | undefined,
  active?: CheckoutSession | null,
): HelperRoute | undefined {
  if (!cwd || cwd === "~") return undefined;
  const key = pathKey(cwd);
  const works = (session: CheckoutSession) => {
    try {
      return pathKey(sessionWorkCwd(session)) === key;
    } catch {
      return false;
    }
  };
  if (active && works(active)) return helperRouteForSession(active);
  const owner = sessions.find(works);
  return owner ? helperRouteForSession(owner) : undefined;
}

export type HelperModelChoice = {
  /** Native model id to request, or undefined for the harness's default. */
  model?: string;
  source: "cheap" | "session" | "default";
};

function matches(model: AgentModel, pattern: RegExp): boolean {
  return pattern.test(`${model.nativeId ?? ""} ${model.name} ${model.id}`);
}

/** Which model a helper prompt asks for. */
export function pickHelperModel(
  route: HelperRoute,
  catalog: readonly AgentModel[] = modelsFor(route.harness),
  live: boolean = hasLiveCatalog(route.harness),
): HelperModelChoice {
  const pattern = CHEAP_MODEL[route.harness];
  if (pattern && (live || !NEEDS_LIVE_CATALOG.has(route.harness))) {
    const cheap = catalog.find((model) => matches(model, pattern));
    if (cheap) {
      const id = (cheap.nativeId ?? nativeModelId(cheap)).trim();
      if (id) return { model: id, source: "cheap" };
    }
  }
  const own = route.modelId ? nativeModelId(route.modelId).trim() : "";
  if (own) return { model: own, source: "session" };
  return { source: "default" };
}

/** True when this route can run a helper prompt now. */
export function canRunHelper(route: HelperRoute): boolean {
  return (
    harnessCan(route.harness, "textPrompt") &&
    canRunHarnessTextPrompt(route.harness)
  );
}

/** The timeout for a helper prompt, stretched for a slow model. */
export function helperTimeoutMs(route: HelperRoute, baseMs: number): number {
  const factor = route.modelId ? modelTimeoutFactor(route.modelId) : 1;
  return baseMs * factor;
}

export class HelperUnavailableError extends Error {
  constructor(harness: HarnessId) {
    super(
      `This session's agent (${harness}) cannot write text on the side. Nothing was sent to another agent.`,
    );
    this.name = "HelperUnavailableError";
  }
}

/** Run one helper prompt on the session's own harness and account. */
export async function runHelperPrompt(
  route: HelperRoute,
  input: {
    cwd: string;
    prompt: string;
    baseTimeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<string> {
  if (!canRunHelper(route)) throw new HelperUnavailableError(route.harness);
  const choice = pickHelperModel(route);
  return runHarnessTextPrompt({
    harness: route.harness,
    cwd: input.cwd,
    ...(route.providerAccountId
      ? { providerAccountId: route.providerAccountId }
      : {}),
    ...(choice.model ? { model: choice.model } : {}),
    ...(choice.source === "session" && route.modelSettings
      ? { modelSettings: route.modelSettings }
      : {}),
    ephemeral: true,
    prompt: input.prompt,
    timeoutMs: helperTimeoutMs(route, input.baseTimeoutMs),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export async function helperCommitMessage(
  route: HelperRoute,
  cwd: string,
  signal?: AbortSignal,
  paths?: readonly string[],
): Promise<string> {
  signal?.throwIfAborted();
  if (!canRunHelper(route)) throw new HelperUnavailableError(route.harness);
  const context = await gitStagedContext(cwd, paths);
  signal?.throwIfAborted();
  const output = await runHelperPrompt(route, {
    cwd,
    prompt: buildCommitMessagePrompt({
      branch: context.branch,
      stagedSummary: context.summary,
      stagedPatch: context.patch,
    }),
    baseTimeoutMs: GIT_TIMEOUT_MS,
    signal,
  });
  const parsed = parseCommitMessage(output);
  if (parsed) return formatCommitMessage(parsed);
  const snippet = output.trim().replace(/\s+/g, " ").slice(0, 240);
  throw new Error(
    snippet
      ? `Could not generate a commit message. Model replied: ${snippet}`
      : "Could not generate a commit message. The model returned no text.",
  );
}

/**
 * PR title and body. Falls back to the commit range, with no model, when the
 * session's harness has no helper or the model gives nothing usable.
 */
export async function helperPrContent(
  route: HelperRoute,
  cwd: string,
): Promise<PrContent & { base: string; head: string }> {
  const range = await gitRangeContext(cwd);
  const fallback = prContentFromRange(range);
  if (!canRunHelper(route)) return fallback;
  let parsed: PrContent | null = null;
  try {
    const output = await runHelperPrompt(route, {
      cwd,
      prompt: buildPrContentPrompt({
        baseBranch: range.base,
        headBranch: range.head,
        commitSummary: range.commitSummary,
        diffSummary: range.diffSummary,
        diffPatch: range.diffPatch,
      }),
      baseTimeoutMs: GIT_TIMEOUT_MS,
    });
    parsed = parsePrContent(output);
  } catch (error) {
    console.debug("[monocode] pr content", error);
  }
  return {
    title: parsed?.title || fallback.title,
    body: parsed?.body || fallback.body,
    base: range.base,
    head: range.head,
  };
}

/** A branch name fragment, or null when there is no helper or no answer. */
export async function helperBranchName(
  route: HelperRoute,
  cwd: string,
  message: string,
): Promise<string | null> {
  if (!canRunHelper(route)) return null;
  try {
    const output = await runHelperPrompt(route, {
      cwd,
      prompt: buildBranchNamePrompt(message),
      baseTimeoutMs: GIT_TIMEOUT_MS,
    });
    return parseBranchName(output);
  } catch (error) {
    console.debug("[monocode] branch name", error);
    return null;
  }
}

/** A sidebar title, or null when there is no helper or no answer. */
export async function helperTitle(
  route: HelperRoute,
  input: { cwd: string; message: string },
): Promise<GeneratedSessionTitle | null> {
  if (!canRunHelper(route)) return null;
  try {
    const output = await runHelperPrompt(route, {
      cwd: input.cwd,
      prompt: buildThreadTitlePrompt(input.message),
      baseTimeoutMs: TITLE_TIMEOUT_MS,
    });
    return parseGeneratedSessionTitle(output, input.message);
  } catch (error) {
    console.debug("[monocode] session title", error);
    return null;
  }
}
