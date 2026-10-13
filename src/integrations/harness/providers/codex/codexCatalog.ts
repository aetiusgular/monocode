import { homeDir } from "../../../../platform/tauri/fs";
import {
  setHarnessModels,
  type AgentModel,
  type ModelSetting,
  type ModelSettingChoice,
} from "../../../../features/sessions/model/models";
import {
  killChild,
  resolveCodexBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "../../core/child";
import { asRecord, stringField } from "./codexProtocol";
import { JsonRpcClient } from "../../core/jsonRpc";
import {
  DEFAULT_PROVIDER_ACCOUNT_ID,
  providerAccounts,
} from "../../../../features/providers/model/providerAccounts";

const PROBE_ID = "monocode-codex-probe";
const DISCOVERY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 12_000;

const REASONING_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

let inflight: Promise<void> | null = null;

export function refreshCodexCatalog(): Promise<void> {
  if (inflight) return inflight;
  inflight = discoverCodexModelsForAccounts()
    .then((models) => {
      if (models.length > 0) setHarnessModels("codex", models);
    })
    .catch((error: unknown) => {
      console.debug("[monocode] codex catalog", error);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The named Codex accounts, such as one model setup wrote for a local server. */
function namedCodexAccounts(): string[] {
  return providerAccounts("codex")
    .map((account) => account.id)
    .filter((id) => id !== DEFAULT_PROVIDER_ACCOUNT_ID);
}

/**
 * Models from the default Codex home and from every named Codex account,
 * default first, each listed once.
 *
 * Listing only the default home left a named account's models out: with no
 * OpenAI sign-in there, the default home refuses, and a local account written
 * by model setup listed nothing (Mac finding 5.3). Each home is probed on its
 * own, in parallel; one that fails leaves the others' models. Throws only
 * when every home failed.
 */
export async function discoverCodexModelsForAccounts(
  accounts: readonly string[] = namedCodexAccounts(),
  discover: (
    workingDirectory?: string,
    providerAccountId?: string,
  ) => Promise<AgentModel[]> = discoverCodexModels,
): Promise<AgentModel[]> {
  const homes: (string | undefined)[] = [undefined, ...accounts];
  const results = await Promise.allSettled(
    homes.map((account) => discover(undefined, account)),
  );
  const lists = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (lists.length === 0) {
    const first = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    throw first?.reason ?? new Error("Codex listed no models");
  }
  return uniqueByNative(lists.flat());
}

export async function discoverCodexModels(
  workingDirectory?: string,
  providerAccountId?: string,
): Promise<AgentModel[]> {
  const cwd = workingDirectory ?? (await homeDir());
  return withCodexProbe(
    {
      cwd,
      ...(providerAccountId ? { providerAccountId } : {}),
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      timeoutMessage: "Codex model discovery timed out",
    },
    async (rpc) => {
      const account = await rpc
        .request<{
          account?: unknown;
          requiresOpenaiAuth?: boolean;
        }>("account/read", {}, REQUEST_TIMEOUT_MS)
        .catch(() => null);

      if (account && !account.account && account.requiresOpenaiAuth) {
        throw new Error(
          "Codex CLI is not authenticated. Run `codex login` and try again.",
        );
      }

      return await listAllModels(rpc);
    },
  );
}

/**
 * Runs `work` against a short-lived Codex app-server, then stops it. The
 * app-server is the configured Codex binary; with a provider account it runs
 * in that account's Codex home, as a session of that account does.
 */
export async function withCodexProbe<T>(
  options: {
    cwd: string;
    providerAccountId?: string;
    timeoutMs: number;
    timeoutMessage: string;
  },
  work: (rpc: JsonRpcClient) => Promise<T>,
): Promise<T> {
  const { path } = await resolveCodexBinary();
  const probeId = `${PROBE_ID}-${crypto.randomUUID()}`;
  const rpc = new JsonRpcClient(
    probeId,
    {
      onRequest: (id) => {
        void rpc.respond(id, {}).catch(() => undefined);
      },
    },
    { includeJsonrpc: false, label: "codex-probe" },
  );

  const stop = async () => {
    rpc.close();
    unwatchChild(probeId);
    await killChild(probeId).catch(() => undefined);
  };

  watchChild(
    probeId,
    (line) => rpc.pushLine(line),
    () => rpc.close(new Error("Codex probe exited")),
  );

  try {
    await spawnChild(
      probeId,
      path,
      ["app-server"],
      options.cwd,
      options.providerAccountId
        ? { provider: "codex", id: options.providerAccountId }
        : undefined,
      "codex",
    );
    return await withTimeout(
      options.timeoutMs,
      options.timeoutMessage,
      async () => {
        await rpc.request(
          "initialize",
          {
            clientInfo: {
              name: "monocode",
              title: "MonoCode",
              version: "0.1.0",
            },
            capabilities: { experimentalApi: true },
          },
          REQUEST_TIMEOUT_MS,
        );
        await rpc.notify("initialized", undefined);
        return await work(rpc);
      },
      () => {
        void stop();
      },
    );
  } finally {
    await stop();
  }
}

async function listAllModels(rpc: JsonRpcClient): Promise<AgentModel[]> {
  const models: AgentModel[] = [];
  const rows: unknown[] = [];
  let cursor: string | null | undefined;
  do {
    const response = await rpc.request<{
      data?: unknown[];
      nextCursor?: string | null;
    }>("model/list", cursor ? { cursor } : {}, REQUEST_TIMEOUT_MS);
    const page = Array.isArray(response.data) ? response.data : [];
    rows.push(...page);
    for (const row of page) {
      const model = parseModel(row);
      if (model) models.push(model);
    }
    cursor = response.nextCursor ?? null;
  } while (cursor);

  return orderDefaultFirst(uniqueByNative(models), rows);
}

export function parseCodexModelList(data: unknown[]): AgentModel[] {
  return orderDefaultFirst(
    uniqueByNative(
      data.flatMap((row) => {
        const model = parseModel(row);
        return model ? [model] : [];
      }),
    ),
    data,
  );
}

function parseModel(raw: unknown): AgentModel | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  if (rec.hidden === true) return null;
  const nativeId =
    stringField(rec, "model") ??
    stringField(rec, "slug") ??
    stringField(rec, "id");
  if (!nativeId) return null;
  const name = formatDisplayName(
    stringField(rec, "displayName") ?? stringField(rec, "name") ?? nativeId,
  );
  const settings = parseModelSettings(rec);
  const vision = parseVision(rec);
  return {
    id: `codex:${nativeId}`,
    harness: "codex",
    name,
    nativeId,
    ...(settings.length > 0 ? { settings } : {}),
    ...(vision !== undefined ? { vision } : {}),
  };
}

/**
 * `inputModalities` from the model list: image input means vision. Absent or
 * malformed leaves it unknown. On a local home this can be Codex's fallback
 * metadata, which claims image input; Settings, Models overrides it.
 */
export function parseVision(rec: Record<string, unknown>): boolean | undefined {
  const modalities = rec.inputModalities;
  if (!Array.isArray(modalities)) return undefined;
  const names = modalities.filter(
    (entry): entry is string => typeof entry === "string",
  );
  if (names.length === 0) return undefined;
  return names.some((entry) => entry.toLowerCase() === "image");
}

function parseModelSettings(rec: Record<string, unknown>): ModelSetting[] {
  const settings: ModelSetting[] = [];
  const efforts = Array.isArray(rec.supportedReasoningEfforts)
    ? rec.supportedReasoningEfforts
    : [];
  const effortOptions: ModelSettingChoice[] = [];
  let defaultEffort: string | undefined;
  for (const entry of efforts) {
    if (typeof entry === "string") {
      effortOptions.push({
        value: entry,
        label: REASONING_LABELS[entry] ?? entry,
      });
      continue;
    }
    const row = asRecord(entry);
    const value = stringField(row, "reasoningEffort") ?? stringField(row, "id");
    if (!value) continue;
    effortOptions.push({
      value,
      label: REASONING_LABELS[value] ?? stringField(row, "label") ?? value,
    });
  }
  const defaultRaw = stringField(rec, "defaultReasoningEffort");
  if (defaultRaw) defaultEffort = defaultRaw;
  if (effortOptions.length > 0) {
    settings.push({
      id: "reasoningEffort",
      label: "Reasoning",
      kind: "select",
      value: defaultEffort ?? effortOptions[0].value,
      options: effortOptions,
    });
  }

  const tiersRaw =
    (Array.isArray(rec.serviceTiers) && rec.serviceTiers.length > 0
      ? rec.serviceTiers
      : Array.isArray(rec.additionalSpeedTiers)
        ? rec.additionalSpeedTiers
        : []) ?? [];
  const tierOptions: ModelSettingChoice[] = [
    { value: "default", label: "Standard" },
  ];
  for (const entry of tiersRaw) {
    if (typeof entry === "string") {
      if (entry === "default") continue;
      tierOptions.push({
        value: entry,
        label: entry === "fast" ? "Fast" : entry,
      });
      continue;
    }
    const row = asRecord(entry);
    const id = stringField(row, "id");
    if (!id || id === "default") continue;
    tierOptions.push({
      value: id,
      label: stringField(row, "name") ?? id,
    });
  }
  if (tierOptions.length > 1) {
    const defaultTier = stringField(rec, "defaultServiceTier") ?? "default";
    settings.push({
      id: "serviceTier",
      label: "Service Tier",
      kind: "select",
      value: tierOptions.some((o) => o.value === defaultTier)
        ? defaultTier
        : "default",
      options: tierOptions,
    });
  }

  return settings;
}

function formatDisplayName(name: string): string {
  return name
    .replace(/^gpt/i, "GPT")
    .replace(/-([a-z])/g, (_, c: string) => `-${c.toUpperCase()}`);
}

function orderDefaultFirst(
  models: AgentModel[],
  rows: unknown[] = [],
): AgentModel[] {
  if (models.length <= 1) return models;
  const defaultNative = rows
    .map((row) => asRecord(row))
    .find((rec) => rec?.isDefault === true);
  const nativeId =
    stringField(defaultNative, "model") ??
    stringField(defaultNative, "slug") ??
    stringField(defaultNative, "id");
  if (!nativeId) return models;
  const index = models.findIndex((model) => model.nativeId === nativeId);
  if (index <= 0) return models;
  return [models[index], ...models.slice(0, index), ...models.slice(index + 1)];
}

function uniqueByNative(models: AgentModel[]): AgentModel[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (!model.nativeId || seen.has(model.nativeId)) return false;
    seen.add(model.nativeId);
    return true;
  });
}

async function withTimeout<T>(
  ms: number,
  message: string,
  work: () => Promise<T>,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = work();
  try {
    return await Promise.race([
      pending,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(message));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    void pending.catch(() => undefined);
  }
}
