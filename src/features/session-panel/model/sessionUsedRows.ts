import type { SessionAttachment, SessionFolder } from "./sessionResources";
import type { SessionToolUse, UseItem } from "./sessionToolUse";

/** What clicking a listed thing does. */
export type UsedAction =
  | { kind: "open"; path: string }
  | { kind: "reveal"; path: string }
  /** Scroll the transcript to the call or message. */
  | { kind: "chat"; blockId: string };

/** One thing in a row's list. */
export type UsedEntry = {
  key: string;
  label: string;
  /** Muted text after the label: a folder, a call count. */
  detail?: string;
  /** The detail gives way before the label does, as a folder should to a name. */
  detailShrinks?: boolean;
  /** The whole thing, for the tooltip, when the label is a shortened form. */
  full?: string;
  /** Lines under the label that are not themselves clickable. */
  sub?: string[];
  /** Command lines and paths read better in the code face. */
  mono?: boolean;
  /** Image thumbnail, when there is one to show. */
  thumb?: string;
  action: UsedAction;
};

export type UsedGroup = {
  /** Heading over the entries, when the row lists more than one kind. */
  title?: string;
  entries: UsedEntry[];
};

export type UsedRowId =
  | "attachments"
  | "folders"
  | "connectors"
  | "files"
  | "commands"
  | "web"
  | "searches"
  | "subagents"
  | "other";

/** One line of "Used in this session", and the list behind it. */
export type UsedRow = {
  id: UsedRowId;
  label: string;
  /** The line's muted summary: usually the first thing in the list. */
  preview: string;
  /** How many more there are than the preview names, shown as "+N". */
  more: number;
  /** Everything in the list, for the list's own heading. */
  total: number;
  groups: UsedGroup[];
};

export type UsedSources = {
  attachments: readonly SessionAttachment[];
  folders: readonly SessionFolder[];
  use: SessionToolUse;
};

/**
 * The rows to show, in a fixed order, leaving out anything the session has not
 * touched. The working folder is always there, so the list is never empty for
 * a session that has a folder.
 */
export function usedRows({
  attachments,
  folders,
  use,
}: UsedSources): UsedRow[] {
  const rows: UsedRow[] = [];

  if (attachments.length > 0) {
    rows.push({
      id: "attachments",
      label: "Attachments",
      preview: attachments[0].name,
      more: attachments.length - 1,
      total: attachments.length,
      groups: [
        {
          entries: attachments.map((attachment) => ({
            key: attachment.key,
            label: attachment.name,
            ...(attachment.previewUrl ? { thumb: attachment.previewUrl } : {}),
            action: attachment.path
              ? { kind: "open", path: attachment.path }
              : { kind: "chat", blockId: attachment.blockId },
          })),
        },
      ],
    });
  }

  if (folders.length > 0) {
    rows.push({
      id: "folders",
      label: "Folders",
      preview: folders[0].shown,
      more: folders.length - 1,
      total: folders.length,
      groups: [
        {
          entries: folders.map((folder) => ({
            key: folder.path,
            label: folder.name,
            detail: folder.role === "working" ? "Working folder" : "Added",
            sub: [folder.shown],
            action: { kind: "reveal", path: folder.path },
          })),
        },
      ],
    });
  }

  if (use.mcpServers.length > 0) {
    rows.push({
      id: "connectors",
      label: "Connectors",
      preview: use.mcpServers[0].server,
      more: use.mcpServers.length - 1,
      total: use.mcpServers.length,
      groups: [
        {
          entries: use.mcpServers.map((entry) => ({
            key: entry.server,
            label: entry.server,
            detail: callsLabel(entry.calls),
            sub: entry.tools.map((tool) =>
              tool.calls > 1 ? `${tool.name} ×${tool.calls}` : tool.name,
            ),
            mono: true,
            action: { kind: "chat", blockId: entry.blockId },
          })),
        },
      ],
    });
  }

  const { items } = use;
  if (items.filesEdited.length + items.filesRead.length > 0) {
    const parts = [
      items.filesEdited.length > 0 ? `${items.filesEdited.length} edited` : "",
      items.filesRead.length > 0 ? `${items.filesRead.length} read` : "",
    ].filter(Boolean);
    rows.push({
      id: "files",
      label: "Files",
      preview: parts.join(" · "),
      more: 0,
      total: items.filesEdited.length + items.filesRead.length,
      groups: [
        { title: "Edited", entries: items.filesEdited.map(fileEntry("edit")) },
        { title: "Read", entries: items.filesRead.map(fileEntry("read")) },
      ].filter((group) => group.entries.length > 0),
    });
  }

  if (items.commands.length > 0) {
    // The list ends on the command run last, which says more about where the
    // session is than the first one does.
    const latest = items.commands[items.commands.length - 1];
    rows.push({
      id: "commands",
      label: "Commands",
      preview: latest.label,
      more: items.commands.length - 1,
      total: items.commands.length,
      groups: [{ entries: items.commands.map(callEntry("command", true)) }],
    });
  }

  if (items.webSearches.length + items.webFetches.length > 0) {
    const first = items.webSearches[0] ?? items.webFetches[0];
    const total = items.webSearches.length + items.webFetches.length;
    rows.push({
      id: "web",
      label: "Web",
      preview: first.label,
      more: total - 1,
      total,
      groups: [
        {
          title: "Searches",
          entries: items.webSearches.map(callEntry("search", false)),
        },
        {
          title: "Pages",
          entries: items.webFetches.map(callEntry("page", false)),
        },
      ].filter((group) => group.entries.length > 0),
    });
  }

  if (items.projectSearches.length > 0) {
    rows.push({
      id: "searches",
      label: "Project searches",
      preview: items.projectSearches[0].label,
      more: items.projectSearches.length - 1,
      total: items.projectSearches.length,
      groups: [{ entries: items.projectSearches.map(callEntry("find", true)) }],
    });
  }

  if (items.subagents.length > 0) {
    rows.push({
      id: "subagents",
      label: "Subagents",
      preview: items.subagents[0].label,
      more: items.subagents.length - 1,
      total: items.subagents.length,
      groups: [{ entries: items.subagents.map(callEntry("agent", false)) }],
    });
  }

  if (items.otherTools.length > 0) {
    rows.push({
      id: "other",
      label: "Other tools",
      preview: items.otherTools[0].label,
      more: items.otherTools.length - 1,
      total: items.otherTools.length,
      groups: [{ entries: items.otherTools.map(callEntry("tool", true)) }],
    });
  }

  return rows;
}

function callsLabel(calls: number): string {
  return calls === 1 ? "1 call" : `${calls} calls`;
}

/** A file by its name, with the folder it sits in beside it. */
function fileEntry(prefix: string) {
  return (item: UseItem, index: number): UsedEntry => {
    const cut = Math.max(
      item.label.lastIndexOf("/"),
      item.label.lastIndexOf("\\"),
    );
    const name = cut >= 0 ? item.label.slice(cut + 1) : item.label;
    const folder = cut > 0 ? item.label.slice(0, cut) : "";
    return {
      key: `${prefix}:${index}:${item.label}`,
      label: name || item.label,
      full: item.label,
      ...(folder ? { detail: folder, detailShrinks: true } : {}),
      mono: true,
      action: item.path
        ? { kind: "open", path: item.path }
        : { kind: "chat", blockId: item.blockId },
    };
  };
}

function callEntry(prefix: string, mono: boolean) {
  return (item: UseItem, index: number): UsedEntry => ({
    key: `${prefix}:${index}:${item.label}`,
    label: item.label,
    ...(item.calls > 1 ? { detail: `×${item.calls}` } : {}),
    ...(mono ? { mono: true } : {}),
    action: { kind: "chat", blockId: item.blockId },
  });
}

/** What an entry's action is called, for its tooltip. */
export function usedActionLabel(action: UsedAction, reveal: string): string {
  if (action.kind === "open") return "Open file";
  if (action.kind === "reveal") return reveal;
  return "Show in chat";
}
