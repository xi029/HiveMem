# Contributing to HiveMem

Thanks for helping! HiveMem is early (v0.1-dev), so issues that describe a real cross-tool memory problem are as valuable as code.

## Development setup

Requires **Node.js ≥ 22.18**, which runs the TypeScript sources directly. There is no build step during development.

```bash
npm install
npm test               # node:test, runs test/**/*.test.ts
npm run typecheck      # tsc --noEmit
npm run check          # types, tests, build, tarball, offline installation and compiled CLI
node src/cli/main.ts   # the CLI from source; set HIVEMEM_HOME=<tmp dir> to keep your real data clean
```

## Where things live

| Path | What |
|---|---|
| `src/ledger/` | Ops, HLC clock, hashing, the deterministic fold and the state machine: **the core** |
| `src/store/` | SQLite store and the CJK-aware full-text tokenizer |
| `src/identity/` | Project identity (git remote → project id) and the runtime context |
| `src/ingest/` | Write path: redaction, dedup, corroboration, claim-key conflicts |
| `src/recall/` | Scoring, scope chain, token-budget packing |
| `src/hooks/` | Hook adapters, managed setup/eject and read-only installation diagnosis |
| `src/cli/` | Argument parsing and commands |
| `docs/` | [DESIGN.md](docs/DESIGN.md) (why), [ARCHITECTURE.md](docs/ARCHITECTURE.md) (how), [research-landscape.md](docs/research-landscape.md) |

## Ground rules

These keep HiveMem trustworthy. A PR that breaks one needs a design discussion first.

1. **The ledger is the source of truth.** State changes only by appending ops. Anything else, such as tables, indexes and generated files, must be rebuildable from the ops.
2. **The fold and claim projection are deterministic.** Do not use `Date.now()`, randomness or iteration-order dependence inside `src/ledger/fold.ts` or `src/ledger/claims.ts`. Recompute claim conflicts from base folds; never use a previously derived quarantine as the source of truth. The convergence tests must keep passing.
3. **No LLM calls and no network in the core.** Optional features that need them belong behind an explicit opt-in.
4. **Zero runtime dependencies** for now. Use what Node ships (`node:sqlite`, `node:crypto`, `node:test`).
5. **Hooks never block the host tool.** On any error a hook prints nothing, logs to `~/.hivemem/hook-errors.log` and exits 0.
6. **Write ≠ belief.** Agent-written memories start `tentative`. Don't add a path that lets an agent commit its own claim without corroboration or user confirmation.

## Good first contributions

- **A hook adapter for another tool.** Record real payloads with `hivemem hook <event> --runtime <tool> --record`, map the event names in `src/hooks/hook.ts`, add a `setup` target, and add a test with a recorded payload.
- **Remember triggers in more languages.** See `REMEMBER` in `src/hooks/hook.ts`.
- **Translations.** The READMEs in `docs/i18n/` must keep the same structure as `README.md`. When you change the English README, note in your PR which translations still need updating.
- **Artwork.** The SVGs in `docs/assets/` are generated, so edit `scripts/gen-assets.mjs` and run `node scripts/gen-assets.mjs` rather than editing the SVGs by hand.

## Pull requests

- Keep each PR focused, and add or adjust tests for any behaviour change.
- `npm run check` must pass. CI runs types, tests and offline package installation on Linux, macOS and Windows with Node 22.18, 22 and 24. `prepack` builds the distributable; the package check never publishes it.
- Test changes to admission with actual concurrent processes and changes to stored projections against the legacy schema. See `test/storage.test.ts` and [trust and recovery](docs/trust-and-recovery.md).
- If you change the data model, ops or invariants, update [ARCHITECTURE.md](docs/ARCHITECTURE.md) in the same PR.
- Commit messages: imperative mood, with a short summary line.

## Reporting bugs and security issues

For a bug, open an issue with your OS, Node version, the tool (Claude Code, Codex, …) and the output of `hivemem project` and `hivemem log --limit 20` (check them for anything private first).

For a security problem, such as a redaction miss or something injected that shouldn't be, **don't open a public issue**. Contact the maintainers privately via a GitHub security advisory.

## License

By contributing you agree that your contributions are licensed under [Apache-2.0](LICENSE).
