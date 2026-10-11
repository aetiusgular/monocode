import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { projectKey, projectName } from "../../../shared/lib/paths";
import { CheckCircle } from "../../../shared/ui/icons";
import { useTabGroupLogos } from "../../projects/hooks/useTabGroupLogos";
import { subscribeProjectPathsChanged } from "../../projects/model/recents";
import type { HarnessId } from "../../sessions/model/session";
import { HarnessIcon } from "../../sessions/ui/HarnessIcon";
import { TerminalSpinner } from "../../sessions/ui/TerminalSpinner";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupLabels,
  loadTabGroupMascots,
  resolveTabGroupColor,
  resolveTabGroupLabel,
  resolveTabGroupLogo,
  resolveTabGroupMascot,
} from "../model/tabGroups";

/**
 * How the title bar marks a project's tabs: the project's colour under each
 * tab, a gap before the next project, and a short stub standing in for a
 * folded group. There is no chip naming the project; the tab's tooltip does.
 */

/** How the rail draws a project, reused for its tabs in the title bar. */
export type ProjectTabLook = {
  key: string;
  name: string;
  color: string;
  logoPath: string | null;
  mascotName: string | null;
  /** Seeds the mascot and the fallback color, as the rail does. */
  seed: string;
};

function loadAppearance() {
  return {
    labels: loadTabGroupLabels(),
    colors: loadTabGroupColors(),
    customColors: loadTabGroupCustomColors(),
    mascots: loadTabGroupMascots(),
  };
}

/** Resolves a project's saved look; follows changes made from the rail. */
export function useProjectTabLook(): (projectPath: string) => ProjectTabLook {
  const [appearance, setAppearance] = useState(loadAppearance);
  const logos = useTabGroupLogos();
  useEffect(
    () => subscribeProjectPathsChanged(() => setAppearance(loadAppearance())),
    [],
  );
  return useCallback(
    (projectPath: string) => {
      const key = projectKey(projectPath);
      const seed = projectName(projectPath);
      return {
        key,
        name: resolveTabGroupLabel(key, appearance.labels, seed),
        color: resolveTabGroupColor(
          key,
          appearance.colors,
          appearance.customColors,
          seed,
        ),
        logoPath: resolveTabGroupLogo(key, logos),
        mascotName: resolveTabGroupMascot(key, appearance.mascots),
        seed,
      };
    },
    [appearance, logos],
  );
}

/** The harnesses a folded group's tabs use, in first-seen order. */
export function stubHarnesses(
  tabs: readonly { harnesses: readonly HarnessId[] }[],
): HarnessId[] {
  const seen: HarnessId[] = [];
  for (const tab of tabs) {
    for (const harness of tab.harnesses) {
      if (!seen.includes(harness)) seen.push(harness);
    }
  }
  return seen;
}

function HarnessStack({ harnesses }: { harnesses: readonly HarnessId[] }) {
  const shown = harnesses.slice(0, 3);
  const extra = harnesses.length - shown.length;
  return (
    <span className="flex shrink-0 items-center">
      {shown.map((harness, index) => (
        <HarnessIcon
          key={harness}
          harness={harness}
          className={`size-3.5 shrink-0 ${index > 0 ? "-ml-1" : ""}`}
        />
      ))}
      {extra > 0 ? (
        <span className="pl-0.5 text-[10px] leading-none">+{extra}</span>
      ) : null}
    </span>
  );
}

/**
 * A folded project in the strip: what its tabs run on, how many there are,
 * and whether one of them is still working or has finished unseen. Click
 * expands; the context menu also closes the group's tabs.
 */
export function ProjectTabStub({
  look,
  count,
  harnesses,
  busy,
  done,
  onExpand,
  onOpenMenu,
  stubRef,
}: {
  look: ProjectTabLook;
  count: number;
  harnesses: readonly HarnessId[];
  /** A tab in the group has a turn in flight. */
  busy: boolean;
  /** A tab in the group finished a turn that has not been looked at. */
  done: boolean;
  onExpand: () => void;
  onOpenMenu: (x: number, y: number, trigger: HTMLElement) => void;
  stubRef?: (el: HTMLButtonElement | null) => void;
}) {
  const tabsWord = count === 1 ? "tab" : "tabs";
  const status = busy
    ? done
      ? ", working, one finished"
      : ", working"
    : done
      ? ", one finished"
      : "";
  return (
    <button
      ref={stubRef}
      type="button"
      title={`${look.name}: ${count} ${tabsWord}${status}. Click to expand.`}
      aria-label={`Expand ${look.name}, ${count} ${tabsWord}${status}`}
      aria-expanded={false}
      data-project-stub={look.key}
      data-project-color={look.color}
      data-project-busy={busy || undefined}
      data-project-done={done || undefined}
      data-tauri-drag-region="false"
      onClick={onExpand}
      onContextMenu={(event: ReactMouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenMenu(event.clientX, event.clientY, event.currentTarget);
      }}
      onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>) => {
        if (
          event.key !== "ContextMenu" &&
          !(event.shiftKey && event.key === "F10")
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        onOpenMenu(rect.left, rect.bottom, event.currentTarget);
      }}
      className="relative flex h-7.5 shrink-0 cursor-default items-center gap-1.5 self-center rounded-md px-2 text-[11px] font-medium tabular-nums text-content/70 hover:bg-content/5 hover:text-content"
    >
      {busy ? (
        <TerminalSpinner className="inline-block w-3.5 select-none text-center text-[11px] leading-none text-accent" />
      ) : (
        <HarnessStack harnesses={harnesses} />
      )}
      <span data-project-stub-count>{count}</span>
      {done ? (
        <span data-project-stub-done className="flex shrink-0">
          <CheckCircle className="size-3 text-teal-400" strokeWidth={2} />
        </span>
      ) : null}
      <ProjectTabMark color={look.color} />
    </button>
  );
}

/** Space between one project's tabs and the next project's. */
export function ProjectTabGap() {
  return <span aria-hidden data-project-gap className="w-3 shrink-0" />;
}

/** A quiet edge under a grouped tab in its project's color. */
export function ProjectTabMark({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      data-project-tint
      className="pointer-events-none absolute inset-x-2 bottom-0.5 h-0.5 rounded-full opacity-60"
      style={{ background: color }}
    />
  );
}
