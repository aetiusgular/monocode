import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Bot } from "../../../shared/ui/icons";
import { subscribeProjectContext } from "../../project-context/model/projectContext";
import { projectName } from "../../../shared/lib/paths";
import {
  acceptAutomationProposal,
  dismissAutomationProposal,
  loadAutomationProposals,
  proposalDraft,
  type AutomationProposal,
} from "../model/automationProposals";
import {
  automationScheduleLabel,
  subscribeAutomations,
  type Automation,
  type AutomationDraft,
} from "../model/automations";
import { RUNTIME_MODE_LABEL } from "../../sessions/model/session";

/**
 * Automation changes an agent asked for (#39). Nothing is saved, changed or
 * removed until the user clicks here. The prompt is shown in full: it is
 * what will run unattended.
 */
export function AutomationProposals({
  projects,
  automations,
  onAccepted,
  onEdit,
  onError,
}: {
  projects: readonly string[];
  automations: readonly Automation[];
  onAccepted: (saved: Automation | null) => void;
  onEdit: (draft: AutomationDraft) => void;
  onError: (message: string) => void;
}) {
  const [items, setItems] = useState<AutomationProposal[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const key = projects.join("\n");

  const load = useCallback(async () => {
    const lists = await Promise.all(
      key
        .split("\n")
        .filter(Boolean)
        .map((project) => loadAutomationProposals(project).catch(() => [])),
    );
    setItems(lists.flat().sort((a, b) => a.at - b.at));
  }, [key]);

  useEffect(() => {
    void load();
    const offContext = subscribeProjectContext(() => void load());
    const offAutomations = subscribeAutomations(() => void load());
    // An agent in another window writes the file; look again now and then.
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      offContext();
      offAutomations();
      window.clearInterval(timer);
    };
  }, [load]);

  if (items.length === 0) return null;

  const act = async (item: AutomationProposal, run: () => Promise<void>) => {
    if (busy) return;
    setBusy(item.id);
    try {
      await run();
      await load();
    } catch (reason: unknown) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      aria-label="Waiting for you"
      className="mx-4 mt-4 shrink-0 space-y-2"
    >
      <h2 className="text-[12px] font-medium text-content/55">
        Waiting for you
      </h2>
      {items.map((item) => {
        const existing = automations.find(
          (automation) => automation.id === item.automationId,
        );
        return (
          <ProposalCard
            key={item.id}
            item={item}
            existing={existing}
            busy={busy === item.id}
            onAccept={() =>
              act(item, async () =>
                onAccepted(
                  await acceptAutomationProposal(item.project, item.id),
                ),
              )
            }
            onEdit={
              item.kind === "remove"
                ? undefined
                : () =>
                    act(item, async () => {
                      const draft = proposalDraft(item, existing);
                      await dismissAutomationProposal(item.project, item.id);
                      if (draft) onEdit(draft);
                    })
            }
            onDismiss={() =>
              act(item, () => dismissAutomationProposal(item.project, item.id))
            }
          />
        );
      })}
    </section>
  );
}

export function proposalHeadline(
  item: AutomationProposal,
  existing: Automation | undefined,
): string {
  const name = existing?.name ?? item.currentName ?? item.name ?? "";
  if (item.kind === "create") return `An agent proposes a new automation`;
  if (item.kind === "remove") return `An agent proposes removing “${name}”`;
  return `An agent proposes changing “${name}”`;
}

export function ProposalCard({
  item,
  existing,
  busy,
  onAccept,
  onEdit,
  onDismiss,
}: {
  item: AutomationProposal;
  existing: Automation | undefined;
  busy: boolean;
  onAccept: () => void;
  onEdit?: () => void;
  onDismiss: () => void;
}) {
  const gone = item.kind !== "create" && !existing;
  const rows: Array<[string, string]> = [];
  if (item.name != null) rows.push(["Name", item.name]);
  if (item.trigger)
    rows.push(["Schedule", automationScheduleLabel(item.trigger)]);
  if (item.runtimeMode)
    rows.push(["Permissions", RUNTIME_MODE_LABEL[item.runtimeMode]]);
  if (item.workspaceMode)
    rows.push([
      "Where",
      item.workspaceMode === "worktree"
        ? "A new worktree"
        : "The project folder",
    ]);
  if (item.keepAwake != null)
    rows.push(["Keep awake", item.keepAwake ? "On" : "Off"]);
  if (item.enabled != null) rows.push(["On", item.enabled ? "Yes" : "No"]);
  if (item.kind === "create" && item.harness)
    rows.push([
      "Runs on",
      `${item.harness}${item.model ? ` · ${item.model}` : ""}`,
    ]);
  rows.push(["Project", projectName(item.project)]);
  const unattended =
    item.runtimeMode === "full-access" || item.runtimeMode === "auto";
  return (
    <article className="rounded-md border border-accent/30 bg-accent/5 px-4 py-3 text-[12px] text-content/75">
      <header className="flex items-center gap-2 text-[13px] font-medium text-content">
        <Bot className="size-3.5 shrink-0 text-accent" strokeWidth={1.75} />
        <span className="min-w-0 truncate">
          {proposalHeadline(item, existing)}
        </span>
      </header>
      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-content/45">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {item.prompt != null ? (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-content/10 bg-content/5 p-2 font-mono text-[11px] text-content/80">
          {item.prompt}
        </pre>
      ) : null}
      {unattended ? (
        <p className="mt-2 flex items-start gap-1.5 text-amber-300/90">
          <AlertCircle className="mt-px size-3.5 shrink-0" />
          <span>
            Runs with nobody watching in {RUNTIME_MODE_LABEL[item.runtimeMode!]}
            . Read the prompt before you accept.
          </span>
        </p>
      ) : null}
      {gone ? (
        <p className="mt-2 text-content/45">
          That automation no longer exists.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {gone ? null : (
          <button
            type="button"
            disabled={busy}
            onClick={onAccept}
            className="h-7 rounded-md bg-accent px-3 text-[12px] font-medium text-white disabled:opacity-50"
          >
            {item.kind === "remove" ? "Remove it" : "Accept"}
          </button>
        )}
        {onEdit && !gone ? (
          <button
            type="button"
            disabled={busy}
            onClick={onEdit}
            className="h-7 rounded-md border border-content/15 px-3 text-[12px] hover:bg-content/8 disabled:opacity-50"
          >
            Edit first
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={onDismiss}
          className="h-7 rounded-md px-3 text-[12px] text-content/55 hover:bg-content/8 disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
    </article>
  );
}
