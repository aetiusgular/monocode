import { invoke } from "@tauri-apps/api/core";
import type { RuntimeMode } from "../../../../features/sessions/model/session";

/**
 * Mac test 10.1, second point (retest 2, 13 Oct). Claude Code runs the
 * read-only git commands on its own list (`git show`, `git log -p`,
 * `git status`, `cd . && git show`) with no permission request, so neither a
 * MonoCode card nor a MonoCode rule ever decides them. In a repository whose
 * own config names a program (a filter, `core.fsmonitor`, a pager, or on a
 * partial clone `remote.<x>.uploadpack`), such a read runs that program: on
 * the Mac a `git show` in a partial clone ran a planted `uploadpack` script.
 *
 * An explicit `ask` rule comes before Claude Code's read-only allow ("deny,
 * then ask, then allow"), so with this rule every git command the agent runs
 * through Bash reaches the permission prompt tool as `can_use_tool`. Seen
 * against the real Claude Code 2.1.292 and 2.1.296 in `tests/cli-contract`
 * (`git-ask`): with no rule 4 of 7 git forms ran unasked and the first ran the
 * plant; with the rule all 7 asked, in default, acceptEdits, plan, auto and
 * bypassPermissions. A separate review tried 25 forms (`command git`, `\git`,
 * a tab, pipes, `true &&`, blame, grep, cat-file): every one asked. MonoCode's
 * card then shows it, and a kept git rule still never answers in such a
 * repository (security fix R2, `commandRuleGate`).
 *
 * Claude Code also runs git itself when it starts, outside any tool call:
 * `git status --short` and `git log` for the git section of its system
 * prompt. It switches off fsmonitor and hooks there but not filters, so a
 * `filter.<x>.clean` ran on a stat-dirty file (review F3). The same launch
 * therefore sets `includeGitInstructions: false`, which drops those calls and
 * that section.
 *
 * What it costs, in such a repository: every git command, `git status`
 * included, shows a card in Supervised, Auto-accept edits and Auto; a plan
 * turn refuses git, as it refuses every command; a change to the repository's
 * config between turns restarts Claude Code on the same conversation, which
 * stops its background commands. The trigger is the R2 list: any partial
 * clone, a submodule or gitlink, a config include, a local `core.hooksPath`
 * (husky), `core.sshCommand`, an alias, a URL rewrite, `gpg.program`, a
 * filter (git-lfs installed per repository), a pager or `core.fsmonitor`.
 *
 * Not covered: git started by something else the agent runs (an npm script,
 * make, a test runner), which is not a Bash command starting with git; and a
 * config the agent writes within a turn after the user allowed that write on
 * a card, which takes effect for the rest of that turn (review F2). Claude
 * Code asks before any write under `.git/`, and that card is the control:
 * once it is allowed the program runs at the user's next `git status` in any
 * terminal too. A config include is counted at the start, since an included
 * file can sit in the work tree where an edit needs no card.
 */
export const CLAUDE_GIT_ASK_RULE = "Bash(git:*)";

export type GitAskInvoke = <T>(
  command: string,
  args: Record<string, unknown>,
) => Promise<T>;

const tauriInvoke: GitAskInvoke = (command, args) => invoke(command, args);

/**
 * Whether a Claude Code session must start with `CLAUDE_GIT_ASK_RULE`: its
 * folder or one of its extra folders is a repository whose own config names
 * a command a read-only git command would run. Read when the process starts
 * and again before every turn, so a repository that changes during a chat
 * gets the rule at its next turn (the process restarts and resumes).
 *
 * Fails closed: an error or an answer that is not `false` adds the rule.
 * Full access adds nothing, since MonoCode answers every request itself there
 * and the agent can run any program anyway.
 */
export async function claudeGitAskNeeded(
  input: {
    cwd: string;
    /** The extra folders that exist, as the launch passes them. */
    extraDirs?: readonly string[];
    runtimeMode: RuntimeMode;
  },
  call: GitAskInvoke = tauriInvoke,
): Promise<boolean> {
  if (input.runtimeMode === "full-access") return false;
  const dirs = [input.cwd, ...(input.extraDirs ?? [])]
    .map((dir) => dir.trim())
    .filter(Boolean);
  if (dirs.length === 0) return false;
  const answers = await Promise.all(
    dirs.map(async (dir) => {
      try {
        return (
          (await call<unknown>("git_repo_names_commands", { cwd: dir })) !==
          false
        );
      } catch {
        return true;
      }
    }),
  );
  return answers.some(Boolean);
}
