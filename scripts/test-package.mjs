import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// Pack and install outside the checkout so missing/stale dist files cannot hide behind source files.
const root = fileURLToPath(new URL('..', import.meta.url));
// Node resolves module paths and cwd through symlinks (macOS /var -> /private/var).
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'hivemem-package-')));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this check with npm run test:package');
const runNpm = (args, cwd) => execFileSync(process.execPath, [npm, ...args], { cwd, encoding: 'utf8', timeout: 120_000 });
try {
  const packed = JSON.parse(runNpm(['pack', '--json', '--pack-destination', temporary], root))[0];
  assert.ok(packed.files.some((file) => file.path === 'dist/cli/main.js'));
  assert.ok(packed.files.some((file) => file.path === 'dist/ledger/claims.js'));
  assert.ok(packed.files.some((file) => file.path === 'dist/mcp/server.js'));
  assert.ok(!packed.files.some((file) => /(^|\/)(node_modules|test)\//.test(file.path) || /\.db(?:-|$)/.test(file.path)));
  runNpm(['install', '--prefix', temporary, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--package-lock=false', join(temporary, packed.filename)], temporary);
  const cli = join(temporary, 'node_modules', 'hivemem', 'dist', 'cli', 'main.js');
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], {
    cwd: temporary, env: { ...process.env, HIVEMEM_HOME: join(temporary, 'memory') }, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(run('--version').trim(), packed.version);
  assert.match(run('demo'), /API fields use snake_case\..*user-stated via claude-code/);
  assert.equal(existsSync(join(temporary, 'memory')), false, 'demo must not initialize the configured store');
  assert.match(run('brief'), /hivemem remember/);
  const memory = JSON.parse(run('remember', 'Packaged CLI works', '--as', 'user', '--json'));
  assert.equal(memory.status, 'committed');
  assert.match(run('brief'), /Packaged CLI works/);
  assert.match(run('brief', '--budget', '0'), /larger --budget/);
  run('revise', memory.id, 'Packaged revisions need review');
  const revised = JSON.parse(run('show', memory.id, '--json'));
  assert.equal(revised.memory.status, 'tentative');
  run('confirm', memory.id);
  run('rebuild');
  assert.match(run('brief'), /Packaged revisions need review/);
  const config = join(temporary, 'host-settings.json');
  const setupArgs = ['--target', 'claude-code', '--config', config, '--json'];
  assert.equal(JSON.parse(run('setup', '--apply', ...setupArgs)).changed, true);
  assert.equal(JSON.parse(run('setup', '--apply', ...setupArgs)).changed, false);
  assert.equal(JSON.parse(run('doctor', ...setupArgs))[0].ok, true);
  const hook = JSON.parse(readFileSync(config, 'utf8')).hooks.SessionStart[0].hooks[0];
  assert.equal(hook.args[0], cli);
  const context = execFileSync(hook.command, hook.args, {
    cwd: temporary, env: { ...process.env, HIVEMEM_HOME: join(temporary, 'memory') }, encoding: 'utf8', timeout: 15_000,
    input: JSON.stringify({ session_id: 'package-smoke', cwd: temporary, hook_event_name: 'SessionStart' }),
  });
  assert.match(JSON.parse(context).hookSpecificOutput.additionalContext, /Packaged revisions need review/);
  assert.equal(JSON.parse(run('setup', '--eject', ...setupArgs)).changed, true);
  assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')), {});
  const installedPackage = JSON.parse(readFileSync(join(temporary, 'node_modules', 'hivemem', 'package.json'), 'utf8'));
  assert.deepEqual(installedPackage.dependencies ?? {}, {});
  const client = new Client({ name: 'package-check', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  const generated = JSON.parse(run('setup', '--mcp', '--target', 'generic', '--cwd', temporary)).mcpServers.hivemem;
  assert.equal(generated.args[0], cli);
  const transport = new StdioClientTransport({ ...generated, cwd: temporary, stderr: 'pipe' });
  try {
    await client.connect(transport, { timeout: 15_000 });
    assert.equal(client.getProtocolEra(), 'modern');
    assert.equal((await client.listTools()).tools.length, 5);
    const recalled = await client.callTool({ name: 'hivemem_recall', arguments: {} });
    assert.match(JSON.stringify(recalled.content), /Packaged revisions need review/);
    const saved = await client.callTool({ name: 'hivemem_remember', arguments: { content: 'Packaged MCP writes work' } });
    assert.equal(saved.structuredContent.status, 'tentative');
  } finally { await client.close(); }
  console.log(`Package check passed: ${packed.filename}; offline installation, built CLI, hooks and MCP client verified.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
