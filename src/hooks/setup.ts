/**
 * Hook configuration snippets per host. v0.1 only prints them; writing host config files
 * (with backup and `--eject`) comes with `hivemem setup --apply`.
 */
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'Stop', 'PreCompact', 'SessionEnd'] as const;

function claudeStyle(runtime: string, bin: string): object {
  return {
    hooks: Object.fromEntries(
      EVENTS.map((e) => [e, [{ hooks: [{ type: 'command', command: `${bin} hook ${e} --runtime ${runtime}`, timeout: 10 }] }]]),
    ),
  };
}

export const TARGETS: Record<string, { file: string; note: string; snippet: (bin: string) => object }> = {
  'claude-code': {
    file: '~/.claude/settings.json (or .claude/settings.json in a project)',
    note: 'Merge the "hooks" object into the file.',
    snippet: (bin) => claudeStyle('claude-code', bin),
  },
  codebuddy: {
    file: '~/.codebuddy/settings.json (or .codebuddy/settings.json in a project)',
    note: 'CodeBuddy Code uses the Claude Code hook schema; merge the "hooks" object.',
    snippet: (bin) => claudeStyle('codebuddy', bin),
  },
  codex: {
    file: '~/.codex/hooks.json',
    note: 'Codex hooks follow a near-identical schema (unverified field-by-field; confirm with a --record run). Trust them via /hooks.',
    snippet: (bin) => claudeStyle('codex', bin),
  },
};

export function setupText(targets: string[], bin = 'hivemem'): string {
  const out: string[] = [];
  for (const t of targets) {
    const spec = TARGETS[t];
    if (!spec) {
      out.push(`unknown target "${t}" (known: ${Object.keys(TARGETS).join(', ')})`);
      continue;
    }
    out.push(`# ${t} -> ${spec.file}`, `# ${spec.note}`, JSON.stringify(spec.snippet(bin), null, 2), '');
  }
  out.push('# Add --record to any command to save raw payloads under ~/.hivemem/recordings/ for debugging.');
  return out.join('\n');
}
