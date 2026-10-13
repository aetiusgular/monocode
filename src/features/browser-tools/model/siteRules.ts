/**
 * Site rules for browser tools: always or never for one host, kept for one
 * chat or for one project. "Once" is not stored.
 *
 * They live in localStorage under `monocode.browserSiteRules`, as the model
 * setup screen keeps its provider list. A chat's rules are keyed by its
 * session id, a project's by its folder. The adapter reads them when a
 * request arrives; the card writes them before it answers, so the next
 * request in the same turn already sees the rule.
 *
 * Storage that throws, or holds anything but this shape, reads as no rules.
 * A never rule wins over an always rule. A chat rule wins over a project rule
 * for the same host.
 */

export type SiteDecision = "always" | "never";
export type SiteScope = "chat" | "project";

type Rules = Record<string, SiteDecision>;
type Store = { chat: Record<string, Rules>; project: Record<string, Rules> };

const STORAGE_KEY = "monocode.browserSiteRules";
const MAX_HOSTS_PER_OWNER = 200;
const MAX_OWNERS = 500;

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function cleanRules(value: unknown): Rules {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Rules = {};
  for (const [host, decision] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (
      host.length > 0 &&
      host.length <= 260 &&
      /^[a-z0-9.\-:[\]]+$/.test(host) &&
      (decision === "always" || decision === "never")
    )
      out[host] = decision;
  }
  return out;
}

function cleanOwners(value: unknown): Record<string, Rules> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, Rules> = {};
  for (const [owner, rules] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (owner.length === 0 || owner.length > 4096) continue;
    const clean = cleanRules(rules);
    if (Object.keys(clean).length) out[owner] = clean;
  }
  return out;
}

export function readSiteRules(): Store {
  const raw = (() => {
    try {
      return storage()?.getItem(STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  })();
  if (!raw) return { chat: {}, project: {} };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      chat: cleanOwners(parsed?.chat),
      project: cleanOwners(parsed?.project),
    };
  } catch {
    return { chat: {}, project: {} };
  }
}

function write(store: Store): boolean {
  try {
    const target = storage();
    if (!target) return false;
    target.setItem(STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

function trimOwners(owners: Record<string, Rules>, keep: string): void {
  const names = Object.keys(owners);
  for (const name of names.slice(0, Math.max(0, names.length - MAX_OWNERS))) {
    if (name !== keep) delete owners[name];
  }
}

/**
 * The same site with or without a leading `www.`, port kept: Claude Code's
 * WebFetch follows a redirect between `x.com` and `www.x.com` on its own, so
 * a rule for one form answers for both. Null for an IP address.
 */
export function wwwTwin(host: string): string | null {
  if (host.startsWith("[")) return null;
  const colon = host.lastIndexOf(":");
  const name = colon >= 0 ? host.slice(0, colon) : host;
  const port = colon >= 0 ? host.slice(colon) : "";
  if (!name || /^[0-9.]+$/.test(name)) return null;
  if (name.startsWith("www.")) {
    const bare = name.slice(4);
    return bare.includes(".") ? bare + port : null;
  }
  return name.includes(".") ? `www.${name}${port}` : null;
}

/**
 * The rule for this host in this chat or project, or null when there is none.
 * `projectDir` is the chat's working folder. `www.<host>` and `<host>` are
 * one site: Never on either blocks both, Always on either allows both.
 */
export function siteRule(
  sessionId: string,
  projectDir: string,
  host: string,
  store: Store = readSiteRules(),
): SiteDecision | null {
  const twin = wwwTwin(host);
  const forms = twin ? [host, twin] : [host];
  const chatRules = store.chat[sessionId];
  const projectRules = store.project[projectDir];
  const ruleIn = (rules: Rules | undefined, decision: SiteDecision) =>
    !!rules &&
    forms.some(
      (form) =>
        Object.prototype.hasOwnProperty.call(rules, form) &&
        rules[form] === decision,
    );
  if (ruleIn(chatRules, "never") || ruleIn(projectRules, "never")) {
    return "never";
  }
  if (ruleIn(chatRules, "always") || ruleIn(projectRules, "always")) {
    return "always";
  }
  return null;
}

/** Keep a rule. Returns false when it could not be saved. */
export function rememberSiteRule(
  scope: SiteScope,
  owner: string,
  host: string,
  decision: SiteDecision,
): boolean {
  if (!owner || !host) return false;
  const store = readSiteRules();
  const owners = store[scope];
  const rules = { ...(owners[owner] ?? {}) };
  delete rules[host];
  rules[host] = decision;
  const hosts = Object.keys(rules);
  for (const old of hosts.slice(
    0,
    Math.max(0, hosts.length - MAX_HOSTS_PER_OWNER),
  ))
    delete rules[old];
  delete owners[owner];
  owners[owner] = rules;
  trimOwners(owners, owner);
  return write(store);
}

/** Forget one host, or every rule a chat or project holds. */
export function forgetSiteRules(
  scope: SiteScope,
  owner: string,
  host?: string,
): boolean {
  const store = readSiteRules();
  const owners = store[scope];
  if (!owners[owner]) return true;
  if (host) {
    delete owners[owner][host];
    if (!Object.keys(owners[owner]).length) delete owners[owner];
  } else delete owners[owner];
  return write(store);
}
