# Harness contract checks

These tests run the real Codex and Claude Code CLIs against fake model servers, to check the protocol behaviour MonoCode builds on. No model, account or network is needed.

```
node tests/cli-contract/run.mjs --codex <path to codex> --claude <path to claude> [--claude <another claude>]
```

- `--only check-3,agents-md` runs some checks. A Claude Code check id gets the version appended, for example `check-2@2.1.296`; `--only check-2` runs it for every version given.
- `--json results.json` writes every result with what it saw.
- `--keep` keeps the temporary homes. Without it, each run removes them at the end.
- A check whose CLI is not given, or not found, is skipped. The exit code is 1 when a check fails or errors, else 0.

Install the CLIs outside the repository. Never add them to `package.json`.

```
npm install --prefix ~/.cache/cli @openai/codex@0.161.0 @anthropic-ai/claude-code@2.1.292
node tests/cli-contract/run.mjs --codex ~/.cache/cli/node_modules/.bin/codex --claude ~/.cache/cli/node_modules/.bin/claude
```

The temporary homes go under `~/.cache/cli-contract-runs` on Linux, because Codex refuses to create its sandbox helper binaries when `CODEX_HOME` is under `/tmp` ("Refusing to create helper binaries under temporary dir"). On macOS they go in the system temp folder. Set `CLI_CONTRACT_TMP` to move them. Both a Codex installed under `/tmp` and one under `~/.cache` gave the same results on 12 Oct.

## Isolation

- Each CLI starts with an empty environment plus a temporary `HOME`, `CODEX_HOME` or `CLAUDE_CONFIG_DIR`, a short `PATH`, and the telemetry switches. Your own homes, sign-ins and keys never reach it.
- Claude Code gets `ANTHROPIC_BASE_URL` at the fake server and a dummy `ANTHROPIC_API_KEY`.
- Codex gets a home with the local home's provider block (`requires_openai_auth = false`, `wire_api = "responses"`) pointed at the fake server, with analytics and OpenTelemetry off.
- The fake servers listen on `127.0.0.1` only, on a free port, and save every request they receive.

## Files

| File | What |
|---|---|
| `run.mjs` | Runs the checks and prints one line per check |
| `checks/codex.mjs` | The Codex checks |
| `checks/claude.mjs` | The Claude Code checks |
| `lib/fakeResponses.mjs` | Fake OpenAI Responses API, streaming |
| `lib/fakeMessages.mjs` | Fake Anthropic Messages API, streaming |
| `lib/codexDriver.mjs` | Starts `codex app-server` and speaks its JSON-RPC as MonoCode does |
| `lib/claudeDriver.mjs` | Starts Claude Code in MonoCode's spawn shape: stream-json in and out, no `-p` |
| `lib/stubMcp.mjs` | A stdio MCP server with two tools |
| `codex-mock/` | A fake model for a third Codex home on the Mac, below |

## codex-mock on the Mac

A fake model that makes Codex ask for approvals, edit files and run commands, so the approval cards can be seen in MonoCode without a GPU. It reads each prompt as one instruction:

| Prompt | What Codex is asked to do |
|---|---|
| `edit hello.py: <old line> => <new line>` | Change one line, through `apply_patch` |
| `write notes.md: <text>` | Add a file, through `apply_patch` |
| `run ls -la` | Run a command, through `exec_command` |
| Anything else | Nothing. It replies with the prompt |

Setup, in macOS Terminal:

1. Start the mock and leave it running: `node ~/Desktop/monocode/tests/cli-contract/codex-mock/serve.mjs`. It prints `codex-mock listening on http://127.0.0.1:11436/v1`. `--port <n>` picks another port; change `base_url` to match.
2. `mkdir -p ~/codex-mock-home && cp ~/Desktop/monocode/tests/cli-contract/codex-mock/config.toml ~/codex-mock-home/`
3. A wrapper named `codex`, like the local home's, in its own folder: `~/codex-mock-bin/codex` with
   ```
   #!/bin/sh
   export CODEX_HOME="$HOME/codex-mock-home"
   exec codex "$@"
   ```
   where the last `codex` is the npm one, by its full path (`which codex`). `chmod +x` it.
4. In MonoCode, Settings, Providers, Agent CLIs, set the Codex path to the wrapper. Every Codex session then uses the mock until the path is set back to the local home's wrapper.
5. Open a scratch repository with a `hello.py` and try `edit hello.py:     return "hi" =>     return "hello"` in Supervised mode. An approval card appears; Allow changes the file.

Known from the cloud run: in Supervised mode, an approved `write` into a folder that does not exist yet fails with "Failed to create parent directories" (Linux sandbox; the Mac's is not checked). Use an existing folder.

The mock's model is not in any catalog, so Codex logs "Model metadata for `codex-mock` not found" and uses its defaults. MonoCode's model picker may need a catalog file like the local home's to list it.
