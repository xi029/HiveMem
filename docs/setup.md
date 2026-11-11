# Connect your tools

HiveMem installs `SessionStart` and `UserPromptSubmit` hooks for Claude Code, Codex and CodeBuddy. They load shared context and recognize explicit `remember that …` prompts. Agent inference capture, pre-compaction rescue and other events are not installed.

Until the npm release, run these commands from a stable checkout and replace `hivemem` with `node src/cli/main.ts`. Installation records the absolute paths to the current Node executable and CLI, so hooks work from other project directories without a global `hivemem` command. Keep that checkout and Node installation in place. After moving either, rerun `setup --apply` from the new location.

## Preview and install

```bash
# Preview snippets without writing anything
hivemem setup --target claude-code

# Preview the merged configuration, including existing settings
hivemem setup --apply --target claude-code --dry-run

# Install into this tool's user configuration
hivemem setup --apply --target claude-code
hivemem doctor --target claude-code
```

Use `codex` or `codebuddy` for another tool. A write requires exactly one explicit target. Repeat for each tool you want to connect.

| Target | Default configuration | Activation |
|---|---|---|
| `claude-code` | `~/.claude/settings.json` | Review `/hooks`, then restart the session |
| `codex` | `$CODEX_HOME/hooks.json`, or `~/.codex/hooks.json` | Review and trust commands in `/hooks`, then restart |
| `codebuddy` | `~/.codebuddy/settings.json` | Review `/hooks`, then restart; Windows requires Git Bash |

Host configuration and trust behaviour follow the [Claude Code hook reference](https://code.claude.com/docs/en/hooks), [Codex hook reference](https://learn.chatgpt.com/docs/hooks) and [CodeBuddy hook reference](https://www.codebuddy.ai/docs/cli/hooks). Claude Code uses direct execution with an argument array. CodeBuddy uses shell commands. Codex uses a Windows-specific command when needed ([upstream execution code](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/command_runner.rs)). On Windows, Codex installation rejects paths containing `%`, `!` or double quotes to avoid command-line expansion; move the checkout or Node installation if necessary. Host versions must support these schemas; shell execution is covered by tests, while real-host acceptance still needs checking in your session.

For a project configuration or custom location, pass the same path to every command:

```bash
hivemem setup --apply --target claude-code --config .claude/settings.json
hivemem doctor --target claude-code --config .claude/settings.json
hivemem setup --eject --target claude-code --config .claude/settings.json
```

Generated commands and installation records contain machine-specific absolute paths. Keep these local; do not commit them as portable team configuration. `setup --target … --bin hivemem` remains available for manual snippets when you manage the executable on `PATH` yourself. `--bin` cannot be combined with managed installation.

## What changes on disk

- Existing settings and other hook entries are preserved. JSON formatting is normalized when a change is needed.
- Every existing file being changed is first backed up alongside it as `<filename>.<unique-id>.bak`; the CLI prints the paths. Backups may contain private host settings, so keep them local.
- `<config>.hivemem.json` records the managed commands. Keep it with the configuration: it makes repeated installation idempotent and uninstall selective.
- Repeating the same installation leaves file contents, hook order and backups unchanged. Moving the installation updates only the recorded hooks.
- `--dry-run` performs the same validation and prints the proposed configuration without creating directories, locks or backups. Its output may include private settings.
- Invalid JSON, JSON with comments, unexpected hook structure, configuration symlinks and modified managed entries cause an error without rewriting the configuration. For a symlink, supply its real target with `--config`.

Existing manually pasted HiveMem hooks are not adopted or deleted automatically. Back up the file, remove only those old HiveMem entries, then use `setup --apply`. Leave other tools' hooks in place.

## Check the installation

```bash
hivemem doctor --target codex
hivemem doctor --target codex --json
```

`doctor` reads the selected configuration and installation record. It checks JSON structure, both managed hooks, launcher file existence, the current Node version and `disableAllHooks` in that file. It does not write settings, create a memory database or execute configured commands. JSON output is an array of reports; exit code `0` means these checks passed, and `1` means an error was found. Without `--target`, it checks all three tools, so an uninstalled tool makes the command exit `1`.

Host approval, configuration overrides in other files, shell availability and real execution remain outside these checks. After reviewing `/hooks`, start a new session in a project with a known memory. Ask the tool about that convention and check the host's hook output if it is missing. `doctor` always includes this verification reminder; successful file checks are not a claim that a host executed the hooks.

## Uninstall or recover

```bash
hivemem setup --eject --target claude-code --dry-run
hivemem setup --eject --target claude-code
```

Eject removes only the two unchanged managed entries and the installation record. It preserves later user edits and all memories. A newly created settings file is left as `{}` when empty. If you edited a managed entry, restore that entry from the latest matching backup before ejecting, or manually remove the HiveMem entries and their installation record after reviewing them.

Setup uses a cooperative lock and atomic replacement of each file. The configuration and installation record are **two files**, so a process or machine crash between replacements can leave an incomplete installation. If `doctor` reports a mismatch after an interruption, inspect the adjacent backups and restore a matching configuration/record pair, preserving unrelated changes made since the backup. For a first installation without a previous record, remove the newly added HiveMem entries before retrying. If a `.hivemem.lock` remains, remove it only after checking that no setup process is running. Avoid editing host settings while setup is writing them.
