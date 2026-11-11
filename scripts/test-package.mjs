import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pack and install outside the checkout so missing/stale dist files cannot hide behind source files.
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'hivemem-package-'));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this check with npm run test:package');
const runNpm = (args, cwd) => execFileSync(process.execPath, [npm, ...args], { cwd, encoding: 'utf8', timeout: 120_000 });
try {
  const packed = JSON.parse(runNpm(['pack', '--json', '--pack-destination', temporary], root))[0];
  assert.ok(packed.files.some((file) => file.path === 'dist/cli/main.js'));
  assert.ok(packed.files.some((file) => file.path === 'dist/ledger/claims.js'));
  assert.ok(!packed.files.some((file) => /(^|\/)(node_modules|test)\//.test(file.path) || /\.db(?:-|$)/.test(file.path)));
  runNpm(['install', '--prefix', temporary, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--package-lock=false', join(temporary, packed.filename)], temporary);
  const cli = join(temporary, 'node_modules', 'hivemem', 'dist', 'cli', 'main.js');
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], {
    cwd: temporary, env: { ...process.env, HIVEMEM_HOME: join(temporary, 'memory') }, encoding: 'utf8', timeout: 15_000,
  });
  const memory = JSON.parse(run('remember', 'Packaged CLI works', '--as', 'user', '--json'));
  assert.equal(memory.status, 'committed');
  assert.match(run('brief'), /Packaged CLI works/);
  run('revise', memory.id, 'Packaged revisions need review');
  const revised = JSON.parse(run('show', memory.id, '--json'));
  assert.equal(revised.memory.status, 'tentative');
  run('confirm', memory.id);
  run('rebuild');
  assert.match(run('brief'), /Packaged revisions need review/);
  console.log(`Package check passed: ${packed.filename}; offline installation and built CLI verified.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
