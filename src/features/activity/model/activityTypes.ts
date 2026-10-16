import type { HarnessId } from "../../sessions/model/session";

/**
 * Wave 3 contract: one entry in the activity log. Written by harness
 * telemetry (OpenTelemetry and MonoCode's own adapter events), the collector
 * around `eslogger`, Cua's recording and the approval path. Lane B owns this
 * file; lanes A and C write through `recordActivity`.
 *
 * Callers treat a missing record as nothing to show, never as an error.
 */
export type ActivitySource =
  "otel" | "adapter" | "eslogger" | "cua" | "approval";

export type ActivityEvent = {
  /** Unique within the log. */
  id: string;
  /** Milliseconds since the Unix epoch. */
  at: number;
  /** The MonoCode chat the event belongs to. Empty when not attributed. */
  chatId: string;
  /** The harness the chat runs on, or "" when not attributed. */
  harness: HarnessId | "";
  source: ActivitySource;
  /** What happened, as a short machine name: `tool.call`, `exec`, `write`. */
  kind: string;
  /** One line a person reads in the panel. */
  summary: string;
  /** The source's fields, kept as data. Never rendered as markup. */
  detail: Record<string, unknown>;
  /** The process that acted, where the source knows it. */
  pid?: number;
  /** The approval that covered the action, when one did. */
  approvalId?: string;
};

/** What an approval covered. */
export type ApprovalSubject = "tool" | "command" | "app" | "folder" | "host";

/** How long an approval held. */
export type ApprovalScope = "once" | "chat" | "always";

/**
 * Wave 3 contract: what one approval card, rule or grant allowed. Lane B
 * owns it. Lane C's computer-use grants write one per app per chat.
 */
export type ApprovalRecord = {
  id: string;
  chatId: string;
  harness: HarnessId | "";
  subject: ApprovalSubject;
  /** The tool name, command prefix, bundle id, folder or host. */
  target: string;
  scope: ApprovalScope;
  /** False for a denial, which the check also reads. */
  granted: boolean;
  /** Milliseconds since the Unix epoch. */
  grantedAt: number;
  /** When it stopped holding. Absent while it holds. */
  endedAt?: number;
};
