import type { ActivityEvent } from "../../activity/model/activityTypes";
import type { HarnessId } from "../../sessions/model/session";
import type { HarnessEvent } from "../../../integrations/harness/core/types";
import { toolKindFromName } from "../../../integrations/harness/providers/claude/claudeProtocol";

/**
 * The harness telemetry feed (wave 3, lane A, items A4 and A5).
 *
 * Two sources describe the same agent actions:
 * - MonoCode's own adapter events (`HarnessEvent`), for every harness. These
 *   are the trusted record: MonoCode parsed them from the harness's stream.
 * - The harness's own OpenTelemetry events, for Claude Code and Codex, from
 *   the loopback receiver. Richer (durations, decisions, model costs), but
 *   written by the harness, so marked `trust: "harness"`.
 *
 * Each tool call and approval is written once. An adapter event is held
 * until its call ends plus `joinWindowMs`, so an OTel event for the same call
 * can join it: first by call id (`tool_use_id` on Claude Code, `call_id` on
 * Codex), else by tool kind and time. A joined event keeps the adapter's id
 * and carries the OTel fields under `detail.otel`. An OTel event that arrives
 * after its adapter event was written is written again under that same id,
 * which the store treats as a replacement. OTel events with no adapter
 * counterpart (model requests, prompts, a subagent's tool calls, decisions
 * made by a rule) are written as they come.
 *
 * Nothing here throws to its caller: a feed that fails drops the event and
 * the turn goes on (corner case 9).
 */

export type FeedOptions = {
  /** How long an ended call waits for its OTel event. */
  joinWindowMs: number;
  /** The longest an adapter event is held, ended or not. */
  maxHoldMs: number;
  /** OTel events this much before an adapter event's start may still join. */
  earlyMs: number;
};

export const DEFAULT_FEED_OPTIONS: FeedOptions = {
  joinWindowMs: 15_000,
  maxHoldMs: 120_000,
  earlyMs: 5_000,
};

/** Calls kept per chat after writing, for late OTel events. */
const RECENT_PER_CHAT = 200;
const RECENT_MS = 10 * 60_000;
/** Held calls per chat. The oldest is written early past this. */
const PENDING_PER_CHAT = 500;
const SUMMARY_CHARS = 200;
const TEXT_CHARS = 2000;

const TERMINAL = new Set([
  "completed",
  "success",
  "failed",
  "error",
  "cancelled",
  "canceled",
]);

type Held = {
  event: ActivityEvent;
  /** Joining keys. */
  callId?: string;
  toolKind: string;
  startedAt: number;
  endedAt?: number;
  joined: boolean;
  written: boolean;
};

type HeldMap = Map<string | number, Held>;

type ChatState = {
  harness: HarnessId | "";
  tools: HeldMap;
  approvals: HeldMap;
  /** Written calls, newest last, for late OTel events. */
  recent: Held[];
  turnActive: boolean;
  seq: number;
};

/** One line of plain text, cut to `max` characters. */
/**
 * The host a fetch-like tool call names, for the check's "new host" flag
 * (lane B's request 4). Only a tool whose kind says fetch, and only the first
 * http(s) URL in its title or preview. Untrusted text: a made-up host can
 * only raise a flag, never clear one.
 */
export function fetchHost(
  toolKind: string | undefined,
  texts: Array<string | undefined>,
): string | undefined {
  if (!toolKind || !/fetch/i.test(toolKind)) return undefined;
  for (const text of texts) {
    if (!text) continue;
    const match = /https?:\/\/[^\s"'<>`]+/i.exec(text.slice(0, 4000));
    if (!match) continue;
    try {
      const host = new URL(match[0]).hostname.toLowerCase();
      if (host && host.length <= 253) return host;
    } catch {
      // Not a URL; try the next text.
    }
  }
  return undefined;
}

function inputText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value).slice(0, 4000);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function clipLine(text: string, max = SUMMARY_CHARS): string {
  let out = "";
  let count = 0;
  for (const ch of text.replace(/[\r\n\t]+/g, " ")) {
    if (/\p{Cc}/u.test(ch)) continue;
    if (count === max) return `${out}…`;
    out += ch;
    count += 1;
  }
  return out.trim();
}

function clipText(text: string): string {
  return text.length > TEXT_CHARS ? `${text.slice(0, TEXT_CHARS)}…` : text;
}

/**
 * The tool kind an OTel tool name means, as MonoCode's adapters name kinds.
 * Claude Code's names go through the same function its adapter uses.
 */
export function otelToolKind(harness: string, toolName: string): string {
  if (harness === "codex") {
    const name = toolName.toLowerCase();
    if (/exec_command|shell|write_stdin|unified_exec/.test(name))
      return "execute";
    if (name.includes("apply_patch")) return "edit";
    if (name.includes("web_search")) return "search";
    if (name.includes("view_image")) return "read";
    return "other";
  }
  return toolKindFromName(toolName);
}

function attrs(event: ActivityEvent): Record<string, unknown> {
  const value = event.detail?.attributes;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export class TelemetryFeed {
  private chats = new Map<string, ChatState>();

  constructor(
    private readonly write: (event: ActivityEvent) => void,
    private readonly options: FeedOptions = DEFAULT_FEED_OPTIONS,
  ) {}

  private chat(chatId: string, harness: HarnessId | ""): ChatState {
    let state = this.chats.get(chatId);
    if (!state) {
      state = {
        harness,
        tools: new Map(),
        approvals: new Map(),
        recent: [],
        turnActive: false,
        seq: 0,
      };
      this.chats.set(chatId, state);
    }
    if (harness) state.harness = harness;
    return state;
  }

  private emit(event: ActivityEvent): void {
    try {
      this.write(event);
    } catch {
      // The log could not take it; the turn goes on.
    }
  }

  private nextId(state: ChatState, chatId: string, part: string): string {
    state.seq += 1;
    return `adapter-${chatId}-${part}-${state.seq}`;
  }

  private writeHeld(state: ChatState, held: Held): void {
    held.written = true;
    this.emit(held.event);
    state.recent.push(held);
    if (state.recent.length > RECENT_PER_CHAT) state.recent.shift();
  }

  private hold(
    state: ChatState,
    map: HeldMap,
    key: string | number,
    held: Held,
  ): void {
    map.set(key, held);
    if (map.size > PENDING_PER_CHAT) {
      const first = map.entries().next().value;
      if (!first) return;
      const [oldestKey, oldest] = first;
      map.delete(oldestKey);
      this.writeHeld(state, oldest);
    }
  }

  /** A4: one adapter event for one chat. */
  adapter(
    chatId: string,
    harness: HarnessId | "",
    event: HarnessEvent,
    now: number,
  ): void {
    try {
      this.adapterEvent(chatId, harness, event, now);
    } catch {
      // Never throws to the queue that called it.
    }
  }

  private adapterEvent(
    chatId: string,
    harness: HarnessId | "",
    event: HarnessEvent,
    now: number,
  ): void {
    if (!chatId) return;
    const state = this.chat(chatId, harness);
    const base = { chatId, harness: state.harness, source: "adapter" as const };
    switch (event.type) {
      case "tool.started":
      case "tool.updated": {
        const existing = state.tools.get(event.callId);
        const status = event.status?.toLowerCase() ?? "";
        if (existing) {
          const detail = existing.event.detail;
          if (event.title) existing.event.summary = clipLine(event.title);
          if (event.kind) {
            detail.toolKind = event.kind;
            existing.toolKind = event.kind;
          }
          if (status) detail.status = status;
          if (event.command) detail.command = clipText(event.command);
          if (event.paths?.length) detail.paths = event.paths.slice(0, 50);
          if (detail.host === undefined) {
            const host = fetchHost(existing.toolKind, [event.title]);
            if (host) detail.host = host;
          }
          if (TERMINAL.has(status) && existing.endedAt === undefined) {
            existing.endedAt = now;
            detail.endedAt = now;
            if (existing.joined)
              this.flushOne(state, state.tools, event.callId);
          }
          return;
        }
        const toolKind = event.kind ?? "other";
        const host = fetchHost(toolKind, [
          event.title,
          ...(event.type === "tool.started" && event.preview
            ? [event.preview.query, event.preview.path, event.preview.title]
            : []),
        ]);
        const held: Held = {
          event: {
            ...base,
            id: this.nextId(state, chatId, "tool"),
            at: now,
            kind: "tool.call",
            summary: clipLine(event.title ?? toolKind),
            detail: {
              callId: event.callId,
              toolKind,
              ...(status ? { status } : {}),
              ...(event.command ? { command: clipText(event.command) } : {}),
              ...(event.paths?.length
                ? { paths: event.paths.slice(0, 50) }
                : {}),
              ...(host ? { host } : {}),
              ...(event.type === "tool.started" && event.background
                ? { background: true }
                : {}),
            },
          },
          callId: event.callId,
          toolKind,
          startedAt: now,
          joined: false,
          written: false,
          ...(TERMINAL.has(status) ? { endedAt: now } : {}),
        };
        this.hold(state, state.tools, event.callId, held);
        return;
      }
      case "approval.requested": {
        const toolKind = event.kind ?? "other";
        const held: Held = {
          event: {
            ...base,
            id: this.nextId(state, chatId, "approval"),
            at: now,
            kind: "approval",
            summary: clipLine(`Asked: ${event.title}`),
            detail: {
              requestId: event.requestId,
              toolKind,
              ...(event.callId ? { callId: event.callId } : {}),
              ...(event.network ? { host: clipLine(event.network.host) } : {}),
              ...(event.site ? { host: clipLine(event.site.host) } : {}),
            },
          },
          callId: event.callId,
          toolKind,
          startedAt: now,
          joined: false,
          written: false,
        };
        this.hold(state, state.approvals, event.requestId, held);
        return;
      }
      case "approval.resolved": {
        const held = state.approvals.get(event.requestId);
        if (!held) return;
        held.endedAt = now;
        held.event.detail.decision = event.decision;
        held.event.detail.endedAt = now;
        held.event.summary = clipLine(
          `${event.decision === "allow" ? "Allowed" : event.decision === "deny" ? "Denied" : "Cancelled"}: ${held.event.summary.replace(/^Asked: /, "")}`,
        );
        if (held.joined) this.flushOne(state, state.approvals, event.requestId);
        return;
      }
      case "turn.started":
        state.turnActive = true;
        this.emit({
          ...base,
          id: this.nextId(state, chatId, "turn"),
          at: now,
          kind: "turn.start",
          summary: "Turn started",
          detail: { providerTurnId: event.providerTurnId },
        });
        return;
      case "turn.ready":
        if (!state.turnActive) return;
        state.turnActive = false;
        this.emit({
          ...base,
          id: this.nextId(state, chatId, "turn"),
          at: now,
          kind: "turn.end",
          summary: "Turn ended",
          detail: {},
        });
        return;
      case "session.ended":
        this.flushChat(state);
        state.turnActive = false;
        this.emit({
          ...base,
          id: this.nextId(state, chatId, "session"),
          at: now,
          kind: "session.end",
          summary:
            event.code == null
              ? "Harness stopped"
              : `Harness stopped (exit ${event.code})`,
          detail: event.code == null ? {} : { code: event.code },
        });
        return;
      case "session.error":
        this.emit({
          ...base,
          id: this.nextId(state, chatId, "session"),
          at: now,
          kind: "session.error",
          summary: clipLine(event.message),
          detail: { message: clipText(event.message) },
        });
        return;
      default:
        return;
    }
  }

  /** A5: a batch from the receiver. */
  otel(events: readonly ActivityEvent[], now: number): void {
    for (const event of events) {
      try {
        this.otelEvent(event, now);
      } catch {
        // Drop this one; keep the rest.
      }
    }
  }

  private otelEvent(event: ActivityEvent, now: number): void {
    if (
      !event ||
      typeof event !== "object" ||
      event.source !== "otel" ||
      !event.chatId
    )
      return;
    const state = this.chat(event.chatId, event.harness);
    const a = attrs(event);
    const callId = str(a.tool_use_id) ?? str(a.call_id);
    const toolName = str(a.tool_name) ?? "";
    const kind = toolName ? otelToolKind(event.harness, toolName) : "";
    // Claude Code's tool_result carries the tool's input with tool details
    // on; a WebFetch names its URL there and nowhere in the adapter event.
    const otelHost = fetchHost(toolName, [
      inputText(a.tool_input),
      inputText(a.tool_parameters),
    ]);
    let map: HeldMap | null = null;
    if (event.kind === "tool.call") map = state.tools;
    else if (event.kind === "approval") map = state.approvals;
    if (!map) {
      this.emit(event);
      return;
    }
    if (otelHost && event.detail.host === undefined) event.detail.host = otelHost;
    const recent: HeldMap = new Map(
      state.recent
        .filter((h) => h.event.kind === event.kind)
        .map((h, i) => [i, h]),
    );
    const held =
      this.match(map, event.harness, callId, kind, event.at, now) ??
      this.match(recent, event.harness, callId, kind, event.at, now, true);
    if (!held) {
      this.emit(event);
      return;
    }
    held.joined = true;
    held.event.detail.otel = {
      event: event.detail.event,
      trust: "harness",
      summary: event.summary,
      attributes: a,
    };
    if (otelHost && held.event.detail.host === undefined)
      held.event.detail.host = otelHost;
    if (held.written) {
      // Late: write it again under the same id.
      this.emit(held.event);
      return;
    }
    if (held.endedAt !== undefined) {
      const key = [...map.entries()].find(([, h]) => h === held)?.[0];
      if (key !== undefined) this.flushOne(state, map, key);
    }
  }

  /**
   * The held call an OTel event belongs to. By call id first. Claude Code's
   * `tool_use_id` is the adapter's call id, so on Claude Code an id that
   * matches nothing means a call the adapter never showed (a subagent's),
   * and it joins nothing. Codex's adapter ids come from app-server items,
   * not proven equal to the OTel `call_id` (read, not run), so there a miss
   * falls back to the same tool kind within the time window, oldest first.
   */
  private match(
    map: HeldMap,
    harness: string,
    callId: string | undefined,
    kind: string,
    at: number,
    now: number,
    written = false,
  ): Held | undefined {
    const open = [...map.values()].filter(
      (h) => !h.joined && h.written === written,
    );
    if (callId) {
      const byId = open.find((h) => h.callId === callId);
      if (byId) return byId;
      if (harness === "claude") return undefined;
    }
    if (!kind) return undefined;
    if (written && now - at > RECENT_MS) return undefined;
    const { earlyMs, joinWindowMs, maxHoldMs } = this.options;
    // A call still running may end at any moment; one written unended was
    // last known running at its hold limit.
    const end = (h: Held) =>
      h.endedAt ?? (written ? h.startedAt + maxHoldMs : now);
    return open
      .filter((h) => h.toolKind === kind)
      .filter((h) => at >= h.startedAt - earlyMs && at <= end(h) + joinWindowMs)
      .sort((x, y) => x.startedAt - y.startedAt)[0];
  }

  private flushOne(state: ChatState, map: HeldMap, key: string | number): void {
    const held = map.get(key);
    if (!held) return;
    map.delete(key);
    this.writeHeld(state, held);
  }

  private flushChat(state: ChatState): void {
    for (const key of [...state.tools.keys()])
      this.flushOne(state, state.tools, key);
    for (const key of [...state.approvals.keys()])
      this.flushOne(state, state.approvals, key);
  }

  /** Writes what has waited long enough. Called on a timer. */
  tick(now: number): void {
    try {
      const { joinWindowMs, maxHoldMs } = this.options;
      for (const [chatId, state] of this.chats) {
        for (const map of [state.tools, state.approvals]) {
          for (const [key, held] of [...map.entries()]) {
            const ended =
              held.endedAt !== undefined && now - held.endedAt >= joinWindowMs;
            if (ended || now - held.startedAt >= maxHoldMs)
              this.flushOne(state, map, key);
          }
        }
        state.recent = state.recent.filter(
          (h) => now - h.startedAt < RECENT_MS,
        );
        if (
          !state.tools.size &&
          !state.approvals.size &&
          !state.recent.length &&
          !state.turnActive
        ) {
          this.chats.delete(chatId);
        }
      }
    } catch {
      // A timer must never throw.
    }
  }

  /** Writes everything held, for a quit or a reload. */
  flushAll(): void {
    for (const state of this.chats.values()) this.flushChat(state);
  }

  /** Held calls, for tests. */
  heldCount(): number {
    let n = 0;
    for (const state of this.chats.values())
      n += state.tools.size + state.approvals.size;
    return n;
  }
}
