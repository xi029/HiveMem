import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nextCheck, watchCodex } from '../scripts/watch-codex.mjs';

const item = (tool: string, type: string, extra = {}) => ({ type, item: { type: 'mcp_tool_call', server: 'hivemem', tool, ...extra } });

test('timeout preserves verified results and distinguishes a later pending tool', async () => {
  const events = [
    { type: 'thread.started' }, { type: 'turn.started' },
    item('hivemem_project', 'item.completed', { status: 'completed', result: { structured_content: { root: '测试' } } }),
    item('hivemem_recall', 'item.started'),
  ];
  const trace = events.map(event => JSON.stringify(event)).join('\r\n') + '\r\n';
  const progress = {};
  const verified: string[] = [];
  const child = `const bytes=Buffer.from(${JSON.stringify(trace)}); const cut=bytes.indexOf(Buffer.from('测'))+1; process.stdout.write(bytes.subarray(0,cut)); setTimeout(()=>process.stdout.write(bytes.subarray(cut)),15); setInterval(()=>{},5000);`;
  await assert.rejects(watchCodex(process.execPath, ['-e', child], {}, progress, (name: string, data: {root: string}) => {
    assert.equal(data.root, '测试'); verified.push(name);
  }, 3000), /timed out/);
  assert.deepEqual(verified, ['hivemem_project']);
  assert.deepEqual(progress, { hostStarted: true, threadStarted: true, turnStarted: true, lastTool: 'hivemem_recall', lastToolState: 'started' });
  assert.match(nextCheck({ configuration: true, project: true, progress }, 'live session'), /hivemem_recall \(started\)/);
});

test('a denied tool cannot pass and raw host error text stays out of the diagnostic', async () => {
  const denied = item('hivemem_remember', 'item.completed', { status: 'failed', error: { message: 'private-host-detail' } });
  const progress = {};
  await assert.rejects(watchCodex(process.execPath, ['-e', `console.log(${JSON.stringify(JSON.stringify(denied))})`], {}, progress, () => assert.fail()),
    (error: Error) => /did not complete hivemem_remember/.test(error.message) && !error.message.includes('private-host-detail'));
  assert.equal((progress as {lastToolState: string}).lastToolState, 'failed');
});

test('a failed model turn cannot pass on a clean process exit', async () => {
  const failure = JSON.stringify({type: 'turn.failed', error: {message: 'private-host-detail'}});
  await assert.rejects(watchCodex(process.execPath, ['-e', `console.log(${JSON.stringify(failure)})`], {}, {}, () => assert.fail()),
    { message: 'Codex reported a failed turn' });
});

test('verified reads start one bounded wait for exit, even if the host repeats them', async () => {
  const result = item('hivemem_inbox', 'item.completed', {status: 'completed', result: {structuredContent: {items: []}}});
  const child = `const emit=()=>console.log(${JSON.stringify(JSON.stringify(result))}); emit(); const repeats=setInterval(emit,50); setTimeout(()=>clearInterval(repeats),1800);`;
  await assert.rejects(watchCodex(process.execPath, ['-e', child], {}, {}, () => true, 5000, 450),
    /timed out finishing the turn after tool verification/);
});

test('stdio markers require successful protocol replies and no memory store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hivemem-probe-'));
  try {
    const run = (messages: unknown[]) => execFileSync(process.execPath, ['--import', new URL('../scripts/host-probe.mjs', import.meta.url).href,
      fileURLToPath(new URL('../src/cli/main.ts', import.meta.url)), 'mcp', '--cwd', dir], {
      env: { ...process.env, HIVEMEM_ACCEPT_DIR: dir, HIVEMEM_HOME: join(dir, 'unused-store') },
      input: messages.map(message => JSON.stringify(message)).join('\n') + '\n', encoding: 'utf8', timeout: 10_000,
    });
    const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
    run([list]);
    assert.deepEqual(readdirSync(dir), ['server-launched']);
    run([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' }, list]);
    assert.deepEqual(readdirSync(dir).sort(), ['protocol-replied', 'server-launched', 'tools-listed']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
