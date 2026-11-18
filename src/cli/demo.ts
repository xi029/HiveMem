import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function demo(cli: string): string {
  const project = mkdtempSync(join(tmpdir(), 'hivemem-demo-'));
  try {
    const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], {
      cwd: project, env: { ...process.env, HIVEMEM_HOME: join(project, 'memory') }, encoding: 'utf8', timeout: 15_000,
    }).trim();
    const convention = 'API fields use snake_case.';
    const saved = run('remember', convention, '--as', 'user', '--runtime', 'claude-code');
    const recalled = JSON.parse(run('recall', 'API fields', '--runtime', 'codex', '--json'));
    const line: string | undefined = recalled.items[0]?.line;
    if (!line) throw new Error('Demo could not recall the saved convention.');
    return [
      'Local demo: two CLI processes stand in for Claude Code and Codex.',
      `1. You tell Claude Code: "${convention}"`, `   ${saved}`,
      '2. A new Codex session looks up "API fields":', `   ${line}`,
      'Demo data removed. To keep a real convention, run this in your own project:',
      `   ${cli.endsWith('.ts') ? `node "${cli}"` : 'hivemem'} remember "API fields use snake_case"`,
    ].join('\n');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}
