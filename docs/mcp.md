# Use HiveMem over MCP

HiveMem provides a local **stdio MCP server**. A compatible desktop app, coding tool or agent framework launches it as a subprocess and calls its tools. It shares the same SQLite ledger as the CLI and hooks, with no LLM calls, network listener or runtime dependencies. Remote Streamable HTTP is not implemented yet.

## Connect a client

Use a stable checkout with Node.js 22.18 or newer. Until the npm release, point the client at the source CLI using **absolute paths**:

```json
{
  "mcpServers": {
    "hivemem": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/hivemem/src/cli/main.ts",
        "mcp",
        "--cwd", "/absolute/path/to/your/project",
        "--runtime", "your-tool-name"
      ]
    }
  }
}
```

This is the common `mcpServers` JSON layout; use your client's documented configuration file or UI. Some clients use another wrapper or TOML. The portable part is the executable and argument array. On Windows, use paths such as `C:/Program Files/nodejs/node.exe` and `E:/projects/hivemem/src/cli/main.ts`, or escape backslashes in JSON. Do not embed shell quotes inside individual arguments. After `npm run build`, `dist/cli/main.js` is also supported.

`--cwd` is required and must name an existing directory. This prevents a desktop client's working directory from silently becoming your memory project. Configure one server entry per project. `--runtime` defaults to `mcp`; choose the same stable tool name used by that host's hooks, such as `codex` or `claude-code`. Merely renaming a client does not establish independent evidence. All clients using the default `mcp` runtime count as the same source.

The client may optionally set `HIVEMEM_HOME` in the subprocess environment to choose a different memory store. Keep the checkout and Node paths valid. This round adds the server command and examples; `setup --apply` continues to install hooks and does not edit MCP client settings.

For a client that should only inspect memory, append `--read-only`. It removes the write tool from discovery and rejects direct attempts to call it. This is a read-only **tool surface**: opening the store may still initialize the database, apply local projection migrations and update project metadata.

## Available tools

| Tool | Use | Main arguments |
|---|---|---|
| `hivemem_recall` | Search memory, or get a project brief without a query | Optional `query`, `budget` (0–8000; default 1200) |
| `hivemem_remember` | Record an agent observation using existing redaction, deduplication and conflict rules | `content`; optional `kind`, `key`, `scope`, `tags`, `importance`, `untrusted` |
| `hivemem_show` | Inspect a visible memory's status, provenance and version history | Full `id` returned by another tool |
| `hivemem_inbox` | List pending memories for human review | Optional `limit` (1–100; default 20) |
| `hivemem_project` | Check the configured project, runtime and visible scopes | None |

For `remember`, supported kinds are `fact`, `decision`, `event` and `procedure`. A claim key is an object such as `{"subject":"project","aspect":"test.command"}`. Writes default to `scope: "project"`; `private` means this user in this project and `agent` means the configured runtime in this project. User-wide writes remain CLI operations. Content is limited to 16,000 Unicode code points; the schemas advertised by `tools/list` describe all limits.

Successful tool results include JSON text and, for protocol versions 2025-06-18 and newer, matching `structuredContent`. Recall's `budget` covers the rendered context inside `text`; scores, IDs and other JSON metadata are additional. Recall is repeatable: explicit MCP queries do not consume the automatic hooks' injection receipts. Inbox entries are brief previews; use `show` for details. Very large histories may require inspection through the CLI.

## Trust and project boundaries

MCP writes use `agent-stated` provenance. New claims start tentative; another configured runtime may corroborate them through the existing heuristic. A single runtime cannot promote its own claim by repeatedly saving it or changing MCP `clientInfo`. Conflicts still go to the inbox, and agent claims cannot supersede user authority.

The model cannot set `as`, `method`, `runtime`, `principal`, `cwd` or arbitrary scope paths in a tool call. Project and runtime come from server startup configuration. Reads are restricted to that context's normal visible scopes, including user-wide memories; direct IDs do not bypass these checks. There are no MCP confirmation, revision, deletion or conflict-resolution tools in this version. Review those changes with the CLI.

Recall excludes quarantined, conflicted, untrusted and claim-blocked content. It can show the configured agent's own tentative observations, labelled with their status. `show` and `inbox` intentionally expose pending content for review, so clients must treat memory text as data rather than instructions. Mark unverified external material `untrusted` when saving it. See [trust and recovery](trust-and-recovery.md).

This is a local, single-user process boundary, not authentication between hostile users. Another process running as the same OS user can access the database or CLI directly. Client identities are informational; they do not grant authority.

## Protocol support and verification

The server supports MCP **2026-07-28** discovery and per-request metadata, plus the **2025-11-25**, **2025-06-18**, **2025-03-26** and **2024-11-05** initialization flows. It implements `server/discover`, legacy `initialize` / `notifications/initialized`, `ping`, `tools/list` and `tools/call`. Tools are the only advertised capability. Resources, prompts, tasks, subscriptions, sampling and elicitation are not exposed.

The implementation follows the official [stdio framing](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio), [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [tool](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) and [legacy lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) specifications. Modern discovery and tool lists include cache metadata; legacy responses retain their compatible shape. Invalid envelopes or arguments produce protocol errors; execution failures produce tool results with `isError: true`.

Only newline-delimited JSON-RPC goes to stdout. Input frames are limited to 1 MiB, invalid UTF-8 is rejected, and an oversized frame closes the transport. EOF closes the database and ends the process. Operations are short, synchronous local transactions; cancellation notifications cannot undo completed writes. Logs and Node's SQLite experimental warnings use stderr.

`npm run check` exercises raw protocol cases and the official TypeScript MCP client's legacy and automatic modern negotiation. The offline package test starts the compiled server from a fresh installation and calls it through that client. The SDK is a development dependency only. Individual host applications still need their own configuration and acceptance check: connect, run `hivemem_project`, recall a known convention, then confirm that a new observation appears as tentative in the CLI inbox.
