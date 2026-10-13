/**
 * The package script a chat's command rule was allowed for (security fix
 * R3). A rule such as `npm test *` runs whatever `package.json` says `test`
 * is, with its `pretest` and `posttest` and the project's `.npmrc`. The agent
 * can rewrite those, so the rule keeps a SHA-256 of them from the moment the
 * user allowed it, and answers only while they still match.
 *
 * Only fingerprints are kept, never a script's text. Per chat, by rule key.
 */

const KEY = "monocode.commandRuleScripts.v1";
const PER_CHAT = 32;
const MAX_CHATS = 300;

type Store = Record<string, Record<string, string>>;

const FINGERPRINT = /^[0-9a-f]{64}$/;

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const out: Store = {};
    for (const [chat, rules] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!rules || typeof rules !== "object" || Array.isArray(rules)) continue;
      const kept: Record<string, string> = {};
      for (const [rule, print] of Object.entries(
        rules as Record<string, unknown>,
      )) {
        if (typeof print === "string" && FINGERPRINT.test(print))
          kept[rule] = print;
      }
      if (Object.keys(kept).length) out[chat] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

function save(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Private mode or a full quota: the rule asks again, which is safe.
  }
}

/** The fingerprint a chat's rule was allowed with, if any. */
export function scriptRuleFingerprint(
  chat: string,
  ruleKey: string,
): string | undefined {
  if (!chat || !ruleKey) return undefined;
  const rules = load()[chat];
  return rules && Object.prototype.hasOwnProperty.call(rules, ruleKey)
    ? rules[ruleKey]
    : undefined;
}

/** Keep the fingerprint the user allowed a chat's rule with. */
export function recordScriptRuleFingerprint(
  chat: string,
  ruleKey: string,
  fingerprint: string,
): void {
  if (!chat || !ruleKey || !FINGERPRINT.test(fingerprint)) return;
  const store = load();
  const rules = { ...(store[chat] ?? {}) };
  delete rules[ruleKey];
  rules[ruleKey] = fingerprint;
  const keys = Object.keys(rules);
  for (const old of keys.slice(0, Math.max(0, keys.length - PER_CHAT)))
    delete rules[old];
  delete store[chat];
  store[chat] = rules;
  const chats = Object.keys(store);
  for (const old of chats.slice(0, Math.max(0, chats.length - MAX_CHATS)))
    delete store[old];
  save(store);
}
