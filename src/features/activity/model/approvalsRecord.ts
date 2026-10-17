import type { HarnessEvent } from "../../../integrations/harness/core/types";
import type { ApprovalOptions } from "../../tool-access/model/networkApproval";
import {
  commandRuleFromKey,
  commandRuleLabel,
} from "../../tool-access/model/commandRules";
import type {
  HarnessId,
  ToolAccess,
  ToolAccessRule,
} from "../../sessions/model/session";
import { recordApproval } from "./activityStore";
import type {
  ApprovalRecord,
  ApprovalScope,
  ApprovalSubject,
} from "./activityTypes";

/**
 * B1: the approvals record. Every approval card, per-chat rule and site rule
 * writes what it allowed, so the check (`src-tauri/src/activity/check.rs`)
 * can set what an agent did against what it was allowed at that time.
 *
 * Cards are read from the harness event stream, once per live event
 * (`HarnessEventQueue.enqueue`, never the reducer, which replays). Rules are
 * read by comparing each chat's rules with what was seen before. A rule that
 * was already there when the app started is not recorded again: it was
 * recorded when it was made, if the log existed then.
 *
 * Every field is data from MonoCode's own state. Harness text (a card's
 * title) is kept as plain text, cut short, and never shown as markup.
 */

const MAX_TARGET = 1_024;
const MAX_PENDING = 512;

type Requested = Extract<HarnessEvent, { type: "approval.requested" }>;

type Pending = {
  subject: ApprovalSubject;
  target: string;
  requestedAt: number;
  /** The host an "Always allow" on this card would keep. */
  host?: string;
};

type ChatInfo = { harness: HarnessId | "" };

function cut(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length > MAX_TARGET ? `${flat.slice(0, MAX_TARGET - 1)}…` : flat;
}

/** What a card is about, from what the harness sent. */
export function cardSubject(event: Requested): {
  subject: ApprovalSubject;
  target: string;
  host?: string;
} {
  if (event.network?.host)
    return {
      subject: "host",
      target: cut(event.network.host),
      host: event.network.host,
    };
  if (event.site?.host)
    return { subject: "host", target: cut(event.site.host) };
  if (event.tool?.key) {
    const rule = commandRuleFromKey(event.tool.key);
    if (rule)
      return { subject: "command", target: cut(commandRuleLabel(rule)) };
    return { subject: "tool", target: cut(event.tool.key) };
  }
  const kind = (event.kind ?? "").toLowerCase();
  if (kind === "command" || kind === "exec" || kind === "bash")
    return { subject: "command", target: cut(event.title) };
  return { subject: "tool", target: cut(event.title || kind || "tool") };
}

function ruleSubject(key: string): {
  subject: ApprovalSubject;
  target: string;
} {
  const rule = commandRuleFromKey(key);
  return rule
    ? { subject: "command", target: cut(commandRuleLabel(rule)) }
    : { subject: "tool", target: cut(key) };
}

type SeenRule = { rule: ToolAccessRule; grantedAt: number };

export class ApprovalsRecorder {
  private chats = new Map<string, ChatInfo>();
  private pending = new Map<string, Pending>();
  private rules = new Map<string, Map<string, SeenRule>>();
  private sites = new Map<string, SeenRule>();
  private sitesSeen = false;

  constructor(
    private readonly write: (record: ApprovalRecord) => void = recordApproval,
    private readonly now: () => number = Date.now,
  ) {}

  harnessOf(chatId: string): HarnessId | "" {
    return this.chats.get(chatId)?.harness ?? "";
  }

  /** A chat's harness and rules, as the app holds them now. */
  noteSession(session: {
    id: string;
    harness: HarnessId;
    toolAccess?: ToolAccess;
  }): void {
    this.chats.set(session.id, { harness: session.harness });
    const next = new Map<string, ToolAccessRule>(
      Object.entries(session.toolAccess ?? {}).filter(
        (entry): entry is [string, ToolAccessRule] =>
          entry[1] === "always" || entry[1] === "never",
      ),
    );
    const seen = this.rules.get(session.id);
    if (!seen) {
      // First sight: these rules predate this run.
      const first = new Map<string, SeenRule>();
      for (const [key, rule] of next) first.set(key, { rule, grantedAt: 0 });
      this.rules.set(session.id, first);
      return;
    }
    const at = this.now();
    for (const [key, before] of seen) {
      if (next.get(key) === before.rule) continue;
      if (before.grantedAt > 0) this.ruleRecord(session.id, key, before, at);
      seen.delete(key);
    }
    for (const [key, rule] of next) {
      if (seen.has(key)) continue;
      const entry = { rule, grantedAt: at };
      seen.set(key, entry);
      this.ruleRecord(session.id, key, entry);
    }
  }

  forgetSession(chatId: string): void {
    this.chats.delete(chatId);
    this.rules.delete(chatId);
    for (const key of [...this.pending.keys()])
      if (key.startsWith(`${chatId}\u0000`)) this.pending.delete(key);
  }

  private ruleRecord(
    chatId: string,
    key: string,
    seen: SeenRule,
    endedAt?: number,
  ): void {
    const { subject, target } = ruleSubject(key);
    this.write({
      id: `rule:${chatId}:${seen.grantedAt}:${key}`.slice(0, 120),
      chatId,
      harness: this.harnessOf(chatId),
      subject,
      target,
      scope: "chat",
      granted: seen.rule === "always",
      grantedAt: seen.grantedAt,
      ...(endedAt === undefined ? {} : { endedAt }),
    });
  }

  /** One live harness event. Called once per event, never for replays. */
  noteHarnessEvent(chatId: string, event: HarnessEvent): void {
    if (event.type === "approval.requested") {
      if (this.pending.size >= MAX_PENDING) {
        const oldest = this.pending.keys().next().value;
        if (oldest !== undefined) this.pending.delete(oldest);
      }
      this.pending.set(`${chatId}\u0000${event.requestId}`, {
        ...cardSubject(event),
        requestedAt: this.now(),
      });
      return;
    }
    if (event.type !== "approval.resolved") return;
    const key = `${chatId}\u0000${event.requestId}`;
    const asked = this.pending.get(key);
    this.pending.delete(key);
    // "cancelled": a hook decided before you could; what it decided is not
    // known here, so nothing is recorded as allowed.
    if (!asked || event.decision === "cancelled") return;
    this.write({
      id: `card:${chatId}:${asked.requestedAt}:${event.requestId}`.slice(
        0,
        120,
      ),
      chatId,
      harness: this.harnessOf(chatId),
      subject: asked.subject,
      target: asked.target,
      scope: "once",
      granted: event.decision === "allow",
      grantedAt: this.now(),
    });
  }

  /**
   * The choice you made on a card, before the harness answers: "Always
   * allow <host>" keeps a standing host rule, "Allow for this chat" a chat
   * one (the chat's rule itself arrives through `noteSession`).
   */
  noteChoice(
    chatId: string,
    requestId: number,
    decision: "allow" | "deny",
    options?: ApprovalOptions,
  ): void {
    const asked = this.pending.get(`${chatId}\u0000${requestId}`);
    const amendment = options?.networkAmendment;
    if (decision !== "allow" || !amendment?.host) return;
    const at = this.now();
    this.write({
      id: `host:${chatId}:${at}:${amendment.host}`.slice(0, 120),
      chatId,
      harness: this.harnessOf(chatId),
      subject: "host",
      target: cut(asked?.host ?? amendment.host),
      scope: "always",
      granted: true,
      grantedAt: at,
    });
  }

  /**
   * The browser tools' site rules (`monocode.browserSiteRules`). A chat's
   * rule is kept under its session id; a project's under its folder, which
   * is recorded with no chat and covers that host everywhere.
   */
  noteSiteRules(store: {
    chat: Record<string, Record<string, "always" | "never">>;
    project: Record<string, Record<string, "always" | "never">>;
  }): void {
    const next = new Map<string, "always" | "never">();
    for (const [owner, rules] of Object.entries(store.chat))
      for (const [host, rule] of Object.entries(rules))
        next.set(`chat\u0000${owner}\u0000${host}`, rule);
    for (const [owner, rules] of Object.entries(store.project))
      for (const [host, rule] of Object.entries(rules))
        next.set(`project\u0000${owner}\u0000${host}`, rule);
    const first = !this.sitesSeen;
    this.sitesSeen = true;
    const at = this.now();
    for (const [key, before] of this.sites) {
      if (next.get(key) === before.rule) continue;
      if (before.grantedAt > 0) this.siteRecord(key, before, at);
      this.sites.delete(key);
    }
    for (const [key, rule] of next) {
      if (this.sites.has(key)) continue;
      const entry = { rule, grantedAt: first ? 0 : at };
      this.sites.set(key, entry);
      if (!first) this.siteRecord(key, entry);
    }
  }

  private siteRecord(key: string, seen: SeenRule, endedAt?: number): void {
    const [scope, owner, host] = key.split("\u0000");
    const chatId = scope === "chat" ? owner : "";
    const scopeName: ApprovalScope = scope === "chat" ? "chat" : "always";
    this.write({
      id: `site:${chatId}:${seen.grantedAt}:${host}`.slice(0, 120),
      chatId,
      harness: chatId ? this.harnessOf(chatId) : "",
      subject: "host",
      target: cut(host),
      scope: scopeName,
      granted: seen.rule === "always",
      grantedAt: seen.grantedAt,
      ...(endedAt === undefined ? {} : { endedAt }),
    });
  }
}

/** The one recorder the app uses. */
export const approvalsRecorder = new ApprovalsRecorder();
