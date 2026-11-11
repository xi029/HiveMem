import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

let directory: string;
const cli = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
before(() => { directory = mkdtempSync(join(tmpdir(), 'hivemem-cli-')); });
after(() => { rmSync(directory, { recursive: true, force: true }); });

function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: directory, env: { ...process.env, HIVEMEM_HOME: join(directory, 'data') }, encoding: 'utf8', timeout: 10_000,
  });
}

describe('CLI workflows', () => {
  it('supports inspect, confirm, revise, rebuild and forget through the public commands', () => {
    const execute = (...args: string[]) => {
      const result = run(...args, '--json');
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const first = execute('remember', 'use npm', '--key', 'project:manager', '--as', 'agent', '--runtime', 'claude-code');
    const second = execute('remember', 'use pnpm', '--key', 'project:manager', '--as', 'agent', '--runtime', 'codex');
    assert.equal(second.status, 'quarantined');
    assert.equal(execute('inbox').length, 2);
    assert.match(run('show', first.id).stdout, /CLAIM CONFLICT/);
    assert.equal(execute('confirm', first.id).status, 'committed');
    assert.equal(execute('show', second.id).memory.status, 'superseded');
    assert.equal(execute('revise', first.id, 'use bun').status, 'tentative');
    execute('confirm', first.id);
    execute('rebuild');
    assert.match(run('brief').stdout, /use bun/);
    execute('forget', first.id);
    assert.equal(run('confirm', first.id).status, 1);
  });

  it('rejects invalid write and recall arguments without creating memories', () => {
    const before = JSON.parse(run('stats', '--json').stdout);
    const invalid = [
      ['remember', 'bad', '--as', 'agnt'],
      ['remember', 'bad', '--as'],
      ['remember', 'bad', '--scope', 'unknown'],
      ['remember', 'bad', '--key', 'project:'],
      ['remember', 'bad', '--importance', 'NaN'],
      ['remember', 'bad', '--importance', '6'],
      ['recall', 'bad', '--budget', 'NaN'],
      ['recall', 'bad', '--budget', '-1'],
    ];
    for (const args of invalid) {
      const result = run(...args);
      assert.equal(result.status, 1, args.join(' '));
      assert.match(result.stderr, /hivemem:/);
    }
    assert.deepEqual(JSON.parse(run('stats', '--json').stdout), before);
  });
});
