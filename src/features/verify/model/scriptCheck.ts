import { pathKey } from "../../../shared/lib/paths";

/**
 * Mac test 6.8: a syntax error in a script the browser loads passes every
 * server check. Vite serves a `.js` file as written, with status 200, and the
 * page goes blank. This check fetches each `.js`, `.mjs` and `.cjs` file the
 * turn changed from the preview server, through the loopback-only fetch, and
 * parses it. No process starts and nothing leaves this machine.
 *
 * TypeScript and JSX are left out: Vite compiles them on the server, so a
 * syntax error there already shows as a server error.
 */

export const SCRIPT_EXTENSIONS = [".js", ".mjs", ".cjs"] as const;
/** Scripts checked after one turn, at most. */
export const MAX_CHECKED_SCRIPTS = 10;

export type ScriptFetch = {
  status?: number | null;
  contentType?: string | null;
  body?: string | null;
  tooLarge?: boolean;
  error?: string | null;
};

export type ScriptParseError = { message: string; line?: number };

export type ScriptProblem = { path: string; line?: number; message: string };

export type ScriptCheck = {
  /** Paths, relative to the server's folder, that were parsed. */
  checked: string[];
  problems: ScriptProblem[];
};

export type ScriptCheckDeps = {
  fetchScript(url: string): Promise<ScriptFetch>;
  /** Null when the text parses. */
  parseScript(text: string): Promise<ScriptParseError | null>;
};

function trimSlash(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * The URL paths the server would serve these files at: each changed script
 * inside the server's folder, outside `node_modules`, relative to that
 * folder. Names keep their spaces and leading dashes, encoded.
 */
export function servedScriptPaths(
  written: readonly string[],
  runCwd: string,
): { relative: string; urlPath: string }[] {
  const root = trimSlash(runCwd);
  const rootKey = pathKey(root);
  const out: { relative: string; urlPath: string }[] = [];
  const seen = new Set<string>();
  for (const raw of written) {
    const path = trimSlash(raw);
    const key = pathKey(path);
    if (!key.startsWith(`${rootKey}/`)) continue;
    const relative = path.slice(root.length + 1);
    const segments = relative.split("/");
    if (
      segments.some(
        (segment) =>
          segment === "" ||
          segment === "." ||
          segment === ".." ||
          segment === "node_modules",
      )
    )
      continue;
    const lower = relative.toLowerCase();
    if (!SCRIPT_EXTENSIONS.some((extension) => lower.endsWith(extension)))
      continue;
    if (seen.has(relative)) continue;
    seen.add(relative);
    out.push({
      relative,
      urlPath: `/${segments.map(encodeURIComponent).join("/")}`,
    });
    if (out.length >= MAX_CHECKED_SCRIPTS) break;
  }
  return out;
}

function looksLikeHtml(fetched: ScriptFetch): boolean {
  const type = fetched.contentType?.toLowerCase() ?? "";
  if (type.includes("html")) return true;
  return /^\s*<(?:!doctype|html)\b/i.test(fetched.body ?? "");
}

/**
 * Fetch and parse each served script. A file the server does not serve
 * (4xx, an HTML fallback page, too large, not text) is not counted. A 5xx
 * answer or a parse error is a problem.
 */
export async function checkServedScripts(
  written: readonly string[],
  runCwd: string,
  previewUrl: string,
  deps: ScriptCheckDeps,
): Promise<ScriptCheck | undefined> {
  const targets = servedScriptPaths(written, runCwd);
  if (targets.length === 0) return undefined;
  let origin: string;
  try {
    origin = new URL(previewUrl).origin;
  } catch {
    return undefined;
  }
  const checked: string[] = [];
  const problems: ScriptProblem[] = [];
  for (const target of targets) {
    let fetched: ScriptFetch;
    try {
      fetched = await deps.fetchScript(`${origin}${target.urlPath}`);
    } catch {
      continue;
    }
    const status = fetched.status ?? undefined;
    if (typeof status !== "number") continue;
    if (status >= 500) {
      problems.push({
        path: target.relative,
        message: `the server answered ${status}`,
      });
      continue;
    }
    if (status < 200 || status >= 300) continue;
    if (fetched.tooLarge || typeof fetched.body !== "string") continue;
    if (looksLikeHtml(fetched)) continue;
    let error: ScriptParseError | null;
    try {
      error = await deps.parseScript(fetched.body);
    } catch {
      continue;
    }
    checked.push(target.relative);
    if (error)
      problems.push({
        path: target.relative,
        ...(error.line ? { line: error.line } : {}),
        message: error.message,
      });
  }
  return checked.length || problems.length ? { checked, problems } : undefined;
}

/**
 * Parse with the acorn parser that ships inside prettier, already a direct
 * dependency the editor loads for Format. Both module and script forms are
 * tried. The message loses prettier's code frame.
 */
export async function parseWithAcorn(
  text: string,
): Promise<ScriptParseError | null> {
  const { parsers } = await import("prettier/plugins/acorn");
  try {
    await parsers.acorn.parse(text, {} as never);
    return null;
  } catch (error: unknown) {
    const record = error as {
      message?: unknown;
      loc?: { start?: { line?: unknown } };
    };
    const line =
      typeof record.loc?.start?.line === "number"
        ? record.loc.start.line
        : undefined;
    const message =
      typeof record.message === "string"
        ? record.message.split("\n")[0].replace(/\s*\(\d+:\d+\)\s*$/, "")
        : "the script does not parse";
    return { message: message.slice(0, 200), ...(line ? { line } : {}) };
  }
}
