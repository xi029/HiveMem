# Host acceptance

Protocol tests and SDK interoperability do not establish that a particular host accepts the configuration, exposes tools to its model, or permits writes. This page separates those checks.

## Observed on 2026-11-16

Windows, Node.js source CLI, temporary project path containing spaces and Chinese characters, isolated `HIVEMEM_HOME`, synthetic memory only. No user host settings were changed.

| Host | Configuration / connection | Actual model tool calls | Write acceptance |
|---|---|---|---|
| Codex CLI 0.167.0 | Generated TOML accepted by `codex mcp get`; stdio server connected | `hivemem_project`, `hivemem_recall`, `hivemem_inbox` completed; recalled the seeded `snake_case` convention | Blocked by host: `MCP tool call requires approval, but approval policy is never`; inbox stayed empty |
| Claude Code 2.1.293 | Executable present; authentication check reports not logged in | Not tested | Not tested |
| CodeBuddy | Executable not found on this machine | Not tested | Not tested |

These are **partial host acceptance results**, not a claim that all integrations are verified. Automatic hook execution in real host sessions remains unverified. Hook command adapters, install/eject and the packaged hook invocation have automated coverage.

## Installed package trial, 2026-11-18

On Windows with Node 24.19.0, we installed the npm tarball offline into a temporary global prefix and ran its `hivemem` command from a separate project with spaces and Chinese characters in its path. Separate processes saved and recalled the user's API convention, then listed an agent's tentative observation in the inbox.

With an isolated `CLAUDE_CONFIG_DIR`, we generated a read-only `.mcp.json` in that project and ran `claude mcp list`. Claude Code 2.1.293 found `hivemem` with the installed executable and project path, then reported **Pending approval**. This verifies configuration discovery only. To proceed in your own project, open `claude` there, review the project server and approve it if you trust it; then verify recall inside the host.

## Repeat the Codex check

On 2026-11-18 the new `doctor --mcp` check classified the actual Claude Code project report as `pending-approval` and the actual Codex stdio entry as `configured`. Neither status is a successful recall. The offline installed-package test matched the seeded ID against a real SDK tool result. A live Codex 0.167.0 rerun parsed the configuration, then timed out after 180 seconds without a verified tool result. The successful live reads on 2026-11-16 remain a separate observation; this rerun did not establish recall or write access.

Two instrumented read-only runs on 2026-11-18 (Windows, Codex 0.167.0) verified the project root but saw no recall-start event before the 180-second deadline. The original prompt required sequential calls, and the local profile used `xhigh` reasoning effort. A fresh run at 09:44 UTC requested the three independent reads together at `low` effort. Within the same deadline the host returned the expected project root, the seeded convention with its full ID, and the inbox; the process exited successfully and the fixture was removed. The retrieval implementation was unchanged. The runs do not isolate which change affected timing.

With separate tool and exit deadlines, a fresh session at 09:52 UTC on the same host verified the inbox and project at 136.245 seconds and recall (text and full seed ID) at 136.462 seconds. Codex exited successfully at 172.197 seconds; the fixture was removed. These are end-to-end times from host launch, not SQLite search latencies. This run covered reads only.

This is an opt-in real model call, using your existing Codex login and quota. It is deliberately excluded from `npm run check` and CI.

```bash
npm run test:host:codex
# On Windows, if the npm shell wrapper cannot be launched, provide the actual executable:
npm run test:host:codex -- --bin /absolute/path/to/codex.exe
```

The script generates TOML, asks the real host to parse it in a temporary `CODEX_HOME`, then runs an ephemeral Codex session with the test server and reasoning effort set for that invocation. Authentication uses your normal Codex profile; it is not copied. The server is read-only by default. The script checks the actual tool results, including the full ID of the memory created for that run. Its JSON report shows milliseconds from host launch to each first verified result in `verifiedAtMs`. It removes its temporary project and store when finished.

The host has 180 seconds to return all required tool results. Only after they are verified does a separate 120-second deadline start for Codex to finish and exit successfully. Duplicate calls cannot extend it. This distinction matters: one real run verified all three reads by 139.1 seconds, but was still waiting for Codex to exit at the old 180-second deadline.

If the session times out, inspect `progress` and `nextCheck` in the final JSON report. `hostStarted` means the Codex process launched; `threadStarted` and `turnStarted` come from its event stream. In the test server only, `serverLaunched` records the Node process starting, `protocolReplied` a successful initialization/discovery reply, and `toolsListed` a successful tool-list reply. These flags are independent: a client need not request every step. `lastTool` and `lastToolState` distinguish a started call, a failed call, a returned result and a verified result. The top-level project, recall and inbox checks keep their verified values even if a later step times out. A false flag means no evidence was observed; it does not establish a root cause. The run still fails on timeout. No raw host events, stderr or memory text are included in the report.

To additionally test writing **when your host's approval policy permits it**:

```bash
npm run test:host:codex -- --write
```

This requests one synthetic observation and checks that both MCP inbox and the independent CLI read see it as `tentative`, attributed to `codex`. A denied or missing tool call fails the check. The script does not relax approvals or hook trust. A noninteractive session that requires interactive approval cannot pass this step; use an interactive host session and approve that specific call instead.

## Complete interactive acceptance

1. Use a temporary project and a separate `HIVEMEM_HOME`; seed a known convention with `remember --as user`.
2. Generate and load its MCP configuration. Check the host's connection status and project identity.
3. Ask the host to recall the convention. Confirm the real tool result contains the seeded text.
4. Ask it to save a different synthetic observation. Approve that specific write when prompted.
5. Inspect the memory using `hivemem inbox` and `hivemem show <id>` with the same project and store. It must be tentative with the correct runtime provenance.
6. Restart the host with `--read-only` in the server arguments. Verify that remember is unavailable and recall still works.

For hooks, separately install into a disposable host profile, review/trust the commands through the host UI, start a new session, and verify both SessionStart injection and UserPromptSubmit behavior. A successful MCP check does not cover hooks.
