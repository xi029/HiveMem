# HiveMem 🐝

**One shared, versioned memory for every agent you use.** Claude Code, Codex, CodeBuddy, Cursor and others read from and write to the same memory store. Every memory carries provenance, contradicting memories wait for review instead of silently overwriting each other, and the store improves itself over time.

**让你同时使用的所有 agent 共用一本记忆账本。** 在 Claude Code 里定下的约定，Codex、CodeBuddy 下次开会话时自动就知道。每条记忆都记着是谁、在哪个工具里写的。agent 之间冲突的说法会进入收件箱等你裁决，而不是互相覆盖。

> Status: **v0.1-dev**. The ledger core, local store, recall, CLI and hook shims work. MCP, git mode, the native memory bridge and the web console are next. See [docs/DESIGN.md](docs/DESIGN.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Why

- Every tool keeps its own memory: CLAUDE.md, AGENTS.md, CODEBUDDY.md and per-tool MEMORY files drift apart.
- Switching tools, for example when you hit a rate limit, means re-explaining everything.
- Built-in auto-memory is opaque: you can't see what was loaded, who wrote it, or fix it.

## What's different

| | HiveMem |
|---|---|
| Source of truth | An append-only **op ledger**. Tables, indexes and instruction files are projections that can be rebuilt from it |
| Multi-agent writes | Replicas **converge deterministically**. Concurrent edits become **sibling versions** to resolve; neither write is lost |
| Trust | **Write ≠ belief**: agent statements stay *tentative* until a second tool corroborates them or you confirm. User statements commit immediately |
| Conflicts | **Claim keys** (`project:test.command`) make contradictions detectable without an LLM. Authority decides; ties go to your inbox |
| Provenance | Every memory records the runtime, agent, session and model that wrote it |
| Cost | The core never calls an LLM |

## Try it (from source)

Requires Node ≥ 22.13.

```bash
npm install
node src/cli/main.ts remember "API 字段统一使用 snake_case" --as user
node src/cli/main.ts remember "Tests run with npm test" --key project:test.command --as agent --runtime claude-code
node src/cli/main.ts remember "Tests run with npm test" --key project:test.command --as agent --runtime codex   # corroborated -> committed
node src/cli/main.ts recall "新接口的字段怎么命名？"
node src/cli/main.ts brief      # what a new session in this repo gets injected
node src/cli/main.ts inbox      # tentative / conflicted / quarantined
node src/cli/main.ts setup      # hook config for Claude Code, Codex, CodeBuddy
npm test
```

## How it plugs in

Hooks inject memory at `SessionStart` and `UserPromptSubmit`, so the model doesn't have to remember to call a tool. Prompts like `记住：…` or `remember that …` are captured as user statements. The same `hivemem hook` command serves Claude Code, Codex and CodeBuddy (one hook schema) and Cursor (its own output format).

## License

Apache-2.0
