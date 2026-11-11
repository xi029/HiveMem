# Trust, conflicts and recovery

This guide describes the implemented local v0.1 behavior. The architecture document also contains future plans.

## Review a disagreement

Use the same claim key for mutually exclusive answers to the same question:

```bash
hivemem remember "Use npm" --key project:pkg.manager --as agent --runtime claude-code
hivemem remember "Use pnpm" --key project:pkg.manager --as agent --runtime codex
hivemem inbox
hivemem show <memory-id>
hivemem confirm <correct-memory-id>
```

Confirmation commits the selected memory and supersedes other active, different answers in the same scope and claim key. The rejected alternatives and their operations remain available through `show`. Repeating the selected text with `remember --as user` performs the same explicit review. A later agent observation cannot override that confirmation.

If two replicas independently created different answers, their IDs may differ. Applying their operations still recomputes the claim group: equal-authority disagreements are quarantined, and lower-authority answers stay tentative. They cannot enter recall while blocked. This is implemented and tested in the local store; a network synchronization service is not yet shipped.

If a *single* memory has multiple sibling versions, first inspect and merge it:

```bash
hivemem show <memory-id>
hivemem resolve <memory-id> --choose <full-version-op-id>
# Or: hivemem resolve <memory-id> --content "The reviewed merged text"
hivemem confirm <memory-id>
```

`resolve` requires exactly one current sibling ID or nonempty replacement text. Both `revise` and `resolve` create tentative content versions: old approvals, evidence and corroborations are not carried over. This also applies to historical revisions when projections are rebuilt after upgrading. Approval operations emitted by this version name the content version they approve; stale approvals are ignored.

## What enters context

- Committed memories are eligible for sharing.
- Unblocked tentative memories are visible to their author; `recall --tentative` allows inspection of other authors' tentative memories in visible scopes.
- Conflicted, quarantined, untrusted, and claim-blocked content is excluded even with `--tentative`. Recall can include a count of memories needing review.
- Receipts track content version and status. Unchanged content is deduplicated within a session; revisions and confirmations can be delivered again. `SessionStart`, including resume/compaction starts, resets that session's receipts. Pre-compaction transcript capture is still planned.
- The token budget covers the rendered wrapper, headings and review note as well as the memories. Token counts are estimates, not model-specific tokenizer guarantees.

Exact duplicate matching preserves case, punctuation and internal whitespace. It requires the same scope, kind and claim key. For example, `C`, `C++` and `C#` are different memories, as are shell commands whose quoted whitespace differs. Deduplication does not depend on full-text search results.

## Trust boundaries

Two distinct runtime names can corroborate an untrusted-flag-free, unblocked tentative statement. This is a convenience heuristic. It does not prove that the observations came from independent evidence or that the claim is true. Untrusted inputs do not add corroboration and cannot supersede trusted user statements.

This is a local tool for a trusted OS user. `--as user`, `confirm`, runtime names and provenance fields are caller declarations, not authenticated identities. Any process with access to the database can impersonate those declarations. Scope filtering is not a multi-user security boundary; authenticated ACL enforcement and remote sync are future work. Op hashes detect accidental changes but do not authenticate writers.

Secret redaction recognizes a finite set of patterns. Review content before sharing or exporting it. Diagnostic hook recordings contain raw payloads when `--record` is enabled.

## Upgrade and rebuild

Close running HiveMem clients before upgrading. Keep a backup of `HIVEMEM_HOME` (default `~/.hivemem`) with clients stopped; retain any SQLite `-wal` and `-shm` files alongside the database if present.

Opening an older database automatically adds the exact-content index and versioned injection receipts, then rebuilds derived memory/search/edge projections from the unchanged operation ledger in one transaction. The projection version is stored in `meta`. Legacy receipts with no version do not suppress current content.

```bash
hivemem rebuild
hivemem stats
hivemem inbox
```

`rebuild` repairs projections and search indexes from existing ops. It cannot recover a missing or corrupt ledger. `forget` is a logical revocation, not physical erasure: the historical content remains in the local operation log. Restoring a backup is the rollback path; do not run old and new binaries against the same database concurrently.

## Development verification

```bash
npm ci
npm run check
```

`check` performs type checking, unit/integration tests, and a package check. The package check builds through `prepack`, produces a tarball, installs it offline into a temporary directory, and exercises its compiled CLI. It does not publish a package or modify your regular memory store. CI runs the same checks on Windows, macOS and Linux.
