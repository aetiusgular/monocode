import { useCallback, useEffect, useRef } from "react";
import {
  invalidateSkills,
  SKILLS_CHANGE_EVENT,
} from "../../skills/model/skills";

/**
 * Drops MonoCode's cached skill catalogs and tells open lists to reload. A
 * user skill shows in every project, so every catalog is dropped, not only
 * this chat's. Composers on harnesses whose catalog MonoCode scans itself
 * (Claude Code and Codex among them) reload on the event; Settings > Skills
 * does too.
 */
export function refreshSkillCatalogs(): void {
  invalidateSkills();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SKILLS_CHANGE_EVENT));
  }
}

/**
 * Returns `armed`, to call once a recording turn is sent. When that chat's
 * turn ends (`busy` goes from true to false) the skill catalogs are
 * refreshed, so the new skill is listed without a restart. The `/` menu and
 * the Skills popover also rescan when they open, which covers a turn that
 * ends after this composer has unmounted.
 */
export function useSkillRecordingRefresh(busy: boolean): () => void {
  const armed = useRef(false);
  const sawBusy = useRef(false);
  useEffect(() => {
    if (!armed.current) return;
    if (busy) {
      sawBusy.current = true;
      return;
    }
    if (!sawBusy.current) return;
    armed.current = false;
    sawBusy.current = false;
    refreshSkillCatalogs();
  }, [busy]);
  return useCallback(() => {
    armed.current = true;
    sawBusy.current = false;
  }, []);
}
