import { useRef, useState } from "react";
import { IS_MAC } from "../../../platform/tauri/platform";
import { Popover } from "../../../shared/ui/Popover";
import { CursorMagicSelection, Square, X } from "../../../shared/ui/icons";
import type { LocalitySession } from "../../server-locality/model/locality";
import { chatSwitch, useChatSwitchVersion } from "../model/chatSwitch";
import {
  chatGrants,
  chatRunning,
  computerUseCliPath,
  computerUseStatus,
  grantApp,
  resolveApp,
  revokeApp,
  setComputerUse,
  stopComputerUse,
  useComputerUseVersion,
  type AppInfo,
} from "../model/client";
import { controlView } from "../model/control";
import { computerUseBlock } from "../model/offer";
import { ApprovalCard } from "./ApprovalCard";

const SELF = "[data-computer-use-control]";

/**
 * The composer's computer-use control: the switch for this chat, the apps it
 * holds, adding one by hand (the same card as an agent's request), and the
 * stop control (C4).
 */
export function ComputerUseControl({
  session,
}: {
  session: LocalitySession & { id?: string };
}) {
  useComputerUseVersion();
  useChatSwitchVersion();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<AppInfo | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>();
  const chatId = session.id;
  if (!chatId) return null;
  const sw = chatSwitch(chatId);
  const grants = chatGrants(chatId);
  const running = chatRunning(chatId);
  const view = controlView({
    block: computerUseBlock(session, {
      isMac: IS_MAC,
      cliPath: computerUseCliPath(),
    }, sw),
    on: sw.on,
    grants: grants.length,
    running,
    helper: computerUseStatus().helper,
  });
  if (!view.visible) return null;

  const stop = async () => {
    const report = await stopComputerUse(chatId);
    setNotice(
      report.warning ??
        (report.releasedButtons.length > 0
          ? `Stopped. Released the ${report.releasedButtons.join(" and ")} mouse button.`
          : "Stopped. Every app for this chat now asks again."),
    );
  };

  const look = async () => {
    setFound(undefined);
    setFound(await resolveApp(query.trim()));
  };

  return (
    <div className="flex items-center gap-1" data-computer-use-control>
      {view.showStop ? (
        <button
          type="button"
          title="Stop computer use in this chat"
          aria-label="Stop computer use in this chat"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void stop()}
          className="flex h-6.5 items-center gap-1 rounded-md border border-red-400/40 px-2 text-[11px] font-medium text-red-400 hover:bg-red-400/10"
        >
          <Square className="size-3" />
          <span>Stop</span>
        </button>
      ) : null}
      <button
        ref={anchor}
        type="button"
        title={view.title}
        aria-label={view.title}
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((was) => !was)}
        className={`flex h-6.5 items-center gap-1 rounded-md px-1.5 text-[11px] hover:bg-content/10 ${
          view.tone === "running"
            ? "text-accent"
            : view.tone === "on"
              ? "text-content"
              : "text-content/50"
        }`}
      >
        <CursorMagicSelection className="size-3.5" />
        {view.tone === "on" || view.tone === "running" ? (
          <span>{view.label}</span>
        ) : null}
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          side="top"
          width={360}
          ignore={SELF}
          onDismiss={() => setOpen(false)}
          aria-label="Computer use"
          className="flex flex-col gap-2 p-3 text-[12px] text-content"
        >
          <label className="flex items-center justify-between gap-2">
            <span className="font-medium">Let this chat use apps on this Mac</span>
            <input
              type="checkbox"
              checked={sw.on}
              onChange={(event) =>
                void setComputerUse(chatId, { ...sw, on: event.target.checked })
              }
            />
          </label>
          {view.note ? <p className="text-content/60">{view.note}</p> : null}
          {view.tone === "blocked" || sw.withoutVision ? (
            <label className="flex items-center justify-between gap-2">
              <span>Use without vision</span>
              <input
                type="checkbox"
                checked={!!sw.withoutVision}
                onChange={(event) =>
                  void setComputerUse(chatId, {
                    on: sw.on || event.target.checked,
                    withoutVision: event.target.checked,
                  })
                }
              />
            </label>
          ) : null}
          {sw.on ? (
            <>
              <p className="text-content/60">
                The agent asks for each app on a card. MonoCode itself is never
                available. Approvals end when you stop or quit MonoCode.
              </p>
              {grants.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {grants.map((grant) => (
                    <li
                      key={grant.approvalId}
                      className="flex items-center justify-between gap-2 rounded-md bg-content/5 px-2 py-1"
                    >
                      <span className="min-w-0 truncate">
                        {grant.appName ?? grant.bundleId}
                        <span className="ml-1 font-mono text-[10px] text-content/50">
                          {grant.bundleId}
                        </span>
                      </span>
                      <button
                        type="button"
                        title={`Remove ${grant.appName ?? grant.bundleId}`}
                        aria-label={`Remove ${grant.appName ?? grant.bundleId}`}
                        onClick={() => void revokeApp(chatId, grant.bundleId)}
                        className="rounded p-0.5 hover:bg-content/10"
                      >
                        <X className="size-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <form
                className="flex gap-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (query.trim()) void look();
                }}
              >
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setFound(undefined);
                  }}
                  placeholder="Add an app: name or bundle id"
                  aria-label="App to add"
                  maxLength={255}
                  className="min-w-0 flex-1 rounded-md border border-content/15 bg-transparent px-2 py-1"
                />
                <button
                  type="submit"
                  className="rounded-md border border-content/15 px-2 py-1 hover:bg-content/5"
                >
                  Find
                </button>
              </form>
              {found === null ? (
                <p className="text-content/60">
                  No app by that name or bundle id was found.
                </p>
              ) : null}
              {found ? (
                <ApprovalCard
                  app={found}
                  session={session}
                  withoutVision={sw.withoutVision}
                  onAllow={async () => {
                    const result = await grantApp(chatId, session.harness, found);
                    if ("error" in result) return result.error;
                    setFound(undefined);
                    setQuery("");
                    return undefined;
                  }}
                  onDeny={async () => {
                    setFound(undefined);
                    return undefined;
                  }}
                />
              ) : null}
            </>
          ) : null}
          {notice ? <p className="text-content/70">{notice}</p> : null}
        </Popover>
      ) : null}
    </div>
  );
}
