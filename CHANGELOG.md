# Changelog

## Unreleased

### Fixed

- SQLite startup installs its busy timeout before WAL initialization and closes the handle if initialization fails, covering concurrent hook/MCP processes.
- Corroboration cannot promote a claim blocked by a user statement or unresolved same-key conflict.
- Independently created same-key records are reconciled after operation ingestion, in any arrival order.
- Admission reads and ledger writes share one SQLite write transaction, preventing concurrent deduplication races.
- Default recall excludes conflicted, quarantined, untrusted and claim-blocked content.
- Exact deduplication preserves punctuation, case, internal whitespace, claim key and kind, including content with no searchable terms.
- New content versions no longer inherit old approvals, evidence or corroborations. Newly emitted approvals are bound to a version.
- Session receipts allow changed versions/statuses to be injected again; session restarts reset receipts.
- Recall budgets include the full rendered context. Invalid budgets and malformed write arguments fail explicitly.
- Conflict resolution validates the chosen sibling and redacts replacement text. Operation ID collisions fail atomically.

### Added

- Local `hivemem mcp --cwd <project>` stdio server with recall, remember, show, inbox and project tools, plus `--read-only`.
- Modern MCP 2026-07-28 discovery and metadata, legacy initialization compatibility, bounded framing and official-client interoperability tests.
- Fixed project/runtime identities for MCP, scoped direct-ID reads and agent-only write authority. See the [MCP guide](docs/mcp.md).
- Managed `setup --apply` / `--eject` for Claude Code, Codex and CodeBuddy, with previews, backups, ownership records and idempotent updates.
- Read-only `doctor` checks and a [setup and recovery guide](docs/setup.md).
- Host-specific launchers with absolute paths, plus shell, configuration-preservation and packaged-hook tests.
- Explicit confirmation resolves same-key disagreements and records the confirming actor.
- Automatic projection migration and `hivemem rebuild` for search/state recovery.
- Tests for real concurrent processes, legacy database migration, trust rules and public CLI workflows.
- `npm run check`, a build-before-pack hook, and offline package installation tests in CI.
- [Trust and recovery guide](docs/trust-and-recovery.md).

### Upgrade notes

- Generated setup snippets now install only `SessionStart` and `UserPromptSubmit`. Manually pasted hooks must be removed before using managed installation; see the setup guide.
- `revise` and `resolve` now leave new content tentative; review it with `show` and use `confirm` before sharing it.
- Rebuilt historical revisions also lose inherited approval. Inspect `inbox` after upgrading.
- Existing ops are preserved. Keep a backup before upgrading, and avoid mixing old and new binaries on one database.
