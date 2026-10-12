#!/usr/bin/env node
// Checks that a parallel lane's branch edits only what its lane may edit.
//
//   node scripts/lane-scope.mjs <lane> [--base <commit>]
//   node scripts/lane-scope.mjs --strip [--dry-run]
//
// The check compares HEAD with the base commit (default
// origin/parallel/base-w1). Errors exit 1. Warnings are listed for the lane's
// status doc, under "Unmarked edits". Uncommitted changes are not checked.
//
// --strip removes every marker line from the tracked files, for the cleanup
// after the last wave.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const OWNERSHIP = join(
  dirname(fileURLToPath(import.meta.url)),
  "lane-ownership.json",
);

export const MARKER =
  /^\s*(?:\/\/ \[lane-([1-5])\] ([a-z0-9-]+)|\{\/\* \[lane-([1-5])\] ([a-z0-9-]+) \*\/\})\s*$/;

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
}

/** The lane and hook of a marker line, or null. */
export function parseMarker(line) {
  const match = MARKER.exec(line);
  if (!match) return null;
  return {
    lane: Number(match[1] ?? match[3]),
    hook: match[2] ?? match[4],
  };
}

function under(path, entry) {
  return entry.endsWith("/") ? path.startsWith(entry) : path === entry;
}

function matchesAny(path, entries) {
  return entries.some((entry) => under(path, entry));
}

/** Which lane owns a path outright, or null. */
export function ownerOf(path, ownership) {
  for (const [lane, card] of Object.entries(ownership.lanes)) {
    if (matchesAny(path, card.owns) || matchesAny(path, card.newPaths)) {
      return Number(lane);
    }
  }
  return null;
}

function isLaneTest(path, lane) {
  return new RegExp(`\\.lane${lane}\\.test\\.tsx?$`).test(path);
}

/**
 * Parses `git diff -U0` output into per-file hunks with the head line numbers
 * of added lines and the text of removed lines.
 */
export function parseHunks(diffText) {
  const files = new Map();
  let current = null;
  let hunk = null;
  let headLine = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
      hunk = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "");
      if (path === "/dev/null") continue;
      current = { hunks: [] };
      files.set(path, current);
      continue;
    }
    if (line.startsWith("--- ")) continue;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      if (!current) continue;
      hunk = {
        baseStart: Number(header[1]),
        headStart: Number(header[3]),
        added: [],
        removed: [],
      };
      headLine = Number(header[3]);
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("+")) {
      hunk.added.push({ line: headLine, text: line.slice(1) });
      headLine += 1;
    } else if (line.startsWith("-")) {
      hunk.removed.push(line.slice(1));
    }
  }
  return files;
}

/**
 * Checks one shared file. `headLines` is the file at HEAD, `hunks` its diff
 * against the base. Returns errors and warnings for `lane`.
 */
export function checkSharedFile(path, lane, headLines, hunks) {
  const errors = [];
  const warnings = [];
  for (const hunk of hunks) {
    for (const text of hunk.removed) {
      if (parseMarker(text)) {
        errors.push(
          `${path}: a marker line was removed, changed or moved: ${text.trim()}`,
        );
      }
    }
    for (const { text } of hunk.added) {
      if (parseMarker(text)) {
        errors.push(
          `${path}: a marker line was added or moved: ${text.trim()}`,
        );
      }
    }
    if (hunk.removed.some((text) => !parseMarker(text))) {
      // A change to existing code: never inside a marker block, since the
      // blocks were empty at the base. Owned spans land here.
      warnings.push(
        `${path}:${hunk.headStart}: lines changed outside every marker block`,
      );
      continue;
    }
    // Pure insertions come in runs; each run must sit directly below this
    // lane's own marker.
    const runs = [];
    let previous = null;
    for (const { line } of hunk.added) {
      if (previous === null || line !== previous + 1) runs.push(line);
      previous = line;
    }
    for (const start of runs) {
      const above = headLines[start - 2];
      const marker = above === undefined ? null : parseMarker(above);
      if (marker && marker.lane === lane) continue;
      if (marker) {
        errors.push(
          `${path}:${start}: lines under lane ${marker.lane}'s ${marker.hook} marker`,
        );
        continue;
      }
      warnings.push(`${path}:${start}: edit outside every marker block`);
    }
  }
  return { errors, warnings };
}

function sharedFilesAt(base) {
  let out = "";
  try {
    out = git(["grep", "-l", "-E", "\\[lane-1\\] [a-z0-9-]+", base, "--"]);
  } catch {
    return new Set();
  }
  return new Set(
    out
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(line.indexOf(":") + 1)),
  );
}

export function checkLane(lane, base, ownership) {
  const errors = [];
  const warnings = [];
  const shared = sharedFilesAt(base);
  const status = git(["diff", "--name-status", "--no-renames", base, "HEAD"])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [code, ...rest] = line.split("\t");
      return { code: code[0], path: rest.join("\t") };
    });
  const diff = parseHunks(git(["diff", "-U0", "--no-renames", base, "HEAD"]));
  const card = ownership.lanes[String(lane)];

  for (const { code, path } of status) {
    if (matchesAny(path, ownership.readOnly)) {
      errors.push(`${path}: read-only during the wave`);
      continue;
    }
    if (matchesAny(path, ownership.lane3Only) && lane !== 3) {
      errors.push(`${path}: only lane 3 changes this file`);
      continue;
    }
    const owner = ownerOf(path, ownership);
    if (owner !== null && owner !== lane) {
      errors.push(`${path}: owned by lane ${owner}`);
      continue;
    }
    if (owner === lane || matchesAny(path, ownership.lane3Only)) continue;
    if (shared.has(path)) {
      if (code === "D") {
        errors.push(`${path}: a shared file was deleted`);
        continue;
      }
      const headLines = git(["show", `HEAD:${path}`]).split("\n");
      const hunks = diff.get(path)?.hunks ?? [];
      const result = checkSharedFile(path, lane, headLines, hunks);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
      continue;
    }
    if (code === "A") {
      if (isLaneTest(path, lane)) continue;
      errors.push(
        `${path}: a new file outside lane ${lane}'s paths (${card.newPaths.join(", ")})`,
      );
      continue;
    }
    if (code === "D") {
      errors.push(`${path}: deletes a file no lane owns`);
      continue;
    }
    warnings.push(`${path}: an edit to a file no lane owns`);
  }
  return { errors, warnings };
}

export function stripMarkers(text) {
  const lines = text.split("\n");
  const kept = lines.filter((line) => !parseMarker(line));
  return { text: kept.join("\n"), removed: lines.length - kept.length };
}

function strip(dryRun) {
  const files = git(["grep", "-l", "-E", "\\[lane-[1-5]\\] [a-z0-9-]+", "--"])
    .split("\n")
    .filter(Boolean);
  let total = 0;
  for (const path of files) {
    const full = join(ROOT, path);
    const { text, removed } = stripMarkers(readFileSync(full, "utf8"));
    if (removed === 0) continue;
    total += removed;
    if (!dryRun) writeFileSync(full, text);
    console.log(
      `${dryRun ? "would strip" : "stripped"} ${removed} from ${path}`,
    );
  }
  console.log(`${total} marker lines in ${files.length} files`);
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes("--strip")) {
    strip(args.includes("--dry-run"));
    return 0;
  }
  const lane = Number(args[0]);
  if (!Number.isInteger(lane) || lane < 1 || lane > 5) {
    console.error(
      "Usage: node scripts/lane-scope.mjs <1-5> [--base <commit>] | --strip [--dry-run]",
    );
    return 2;
  }
  const baseIndex = args.indexOf("--base");
  const base = baseIndex >= 0 ? args[baseIndex + 1] : "origin/parallel/base-w1";
  if (!base) {
    console.error("--base needs a commit");
    return 2;
  }
  try {
    git(["rev-parse", "--verify", `${base}^{commit}`], { stdio: "pipe" });
  } catch {
    console.error(`Base ${base} not found. Fetch it, or pass --base <commit>.`);
    return 2;
  }
  const ownership = JSON.parse(readFileSync(OWNERSHIP, "utf8"));
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]).trim();
  const { errors, warnings } = checkLane(lane, base, ownership);
  for (const warning of warnings) console.log(`warning: ${warning}`);
  for (const error of errors) console.log(`error: ${error}`);
  if (dirty) console.log("note: uncommitted changes are not checked");
  console.log(
    `lane ${lane} against ${base}: ${errors.length} errors, ${warnings.length} warnings`,
  );
  return errors.length > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv);
}
