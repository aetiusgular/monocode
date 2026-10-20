import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * B4 and B7 from the settings page: the collector's status, its install
 * plan (shown before anything runs), and the screenshot floor.
 */

export type CollectorStatus = {
  supported: boolean;
  installed: boolean;
  reachable: boolean;
  registered: number;
  detail?: Record<string, unknown>;
  problem?: string;
  /** `eslogger: <its last stderr line>` while eslogger is not running. */
  esloggerProblem?: string;
};

export type InstallPlan = {
  route: "smAppService" | "terminal";
  explanation: string[];
  plist: string;
  commands: string[];
  stagedPlist?: string;
  /** The installed daemon, the file to grant Full Disk Access to. */
  daemonPath?: string;
};

export const NO_STATUS: CollectorStatus = {
  supported: false,
  installed: false,
  reachable: false,
  registered: 0,
};

const FLOOR_KEY = "monocode.activity.screenshotFloorGb";
export const DEFAULT_FLOOR_GB = 2;
export const MIN_FLOOR_GB = 0.25;
export const MAX_FLOOR_GB = 512;

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** A floor in GB, clamped to what the Rust side accepts. */
export function clampFloorGb(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return DEFAULT_FLOOR_GB;
  return Math.min(MAX_FLOOR_GB, Math.max(MIN_FLOOR_GB, number));
}

export function loadFloorGb(): number {
  try {
    const raw = storage()?.getItem(FLOOR_KEY);
    return raw === null || raw === undefined
      ? DEFAULT_FLOOR_GB
      : clampFloorGb(Number(raw));
  } catch {
    return DEFAULT_FLOOR_GB;
  }
}

/** Saves the floor and hands it to the log. */
export async function saveFloorGb(value: number): Promise<number> {
  const floor = clampFloorGb(value);
  try {
    storage()?.setItem(FLOOR_KEY, String(floor));
  } catch {
    // Kept for this run only.
  }
  await applyFloor(floor);
  return floor;
}

export async function applyFloor(
  floorGb: number = loadFloorGb(),
): Promise<void> {
  try {
    if (!isTauri()) return;
    await invoke("activity_set_retention", {
      settings: {
        screenshotFloorBytes: Math.round(clampFloorGb(floorGb) * 1024 ** 3),
      },
    });
  } catch {
    // The default floor stays.
  }
}

export async function collectorStatus(): Promise<CollectorStatus> {
  try {
    if (!isTauri()) return NO_STATUS;
    return await invoke<CollectorStatus>("activity_collector_status");
  } catch {
    return NO_STATUS;
  }
}

export async function collectorInstallPlan(): Promise<InstallPlan> {
  return invoke<InstallPlan>("activity_collector_install_plan");
}

export async function registerCollector(): Promise<string> {
  return invoke<string>("activity_collector_register");
}

/** Removes a bundled collector, or returns the commands to remove one by hand. */
export async function removeCollector(): Promise<string[]> {
  return invoke<string[]>("activity_collector_unregister");
}

/** One line on where the collector stands. */
export function statusLine(status: CollectorStatus): string {
  if (!status.supported) return "The collector runs only on macOS.";
  if (status.reachable) {
    const eslogger = status.detail?.eslogger;
    if (eslogger === "running")
      return "Running. Recording what MonoCode's processes do.";
    // eslogger's own reason, such as "Caller lacks TCC authorization for
    // Full Disk Access" (Mac test 3.4).
    const error = status.detail?.esloggerError;
    if (typeof error === "string" && error.trim())
      return `Running, but eslogger stopped: ${error.trim().slice(0, 300)}`;
    return `Running, but eslogger is ${typeof eslogger === "string" ? eslogger : "not running"}.`;
  }
  if (status.installed)
    return status.problem ?? "Installed, but not answering.";
  return "Not installed. Nothing at the system level is recorded.";
}
