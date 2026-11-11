import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { openContext } from '../src/identity/context.ts';
import { remember } from '../src/ingest/write.ts';
import { MAX_MESSAGE_BYTES, McpSession, MODERN_VERSION, serveMcp } from '../src/mcp/server.ts';

const cli = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
const meta = { 'io.modelcontextprotocol/protocolVersion': MODERN_VERSION, 'io.modelcontextprotocol/clientCapabilities': {} };
let directory: string;
let previousHome: string | undefined;
let sessions: McpSession[];
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'hivemem-mcp-')));
  previousHome = process.env.HIVEMEM_HOME;
  process.env.HIVEMEM_HOME = join(directory, 'data');
  sessions = [];
});
afterEach(() => {
  for (const session of sessions) session.close();
  if (previousHome === undefined) delete process.env.HIVEMEM_HOME;
  else process.env.HIVEMEM_HOME = previousHome;
  rmSync(directory, { recursive: true, force: true });
});
function server(readOnly = false) {
  const session = new McpSession({ cwd: directory, runtime: 'codex', readOnly });
  sessions.push(session);
  return session;
}
function request(session: McpSession, method: string, params: Record<string, unknown> = {}, modern = true): any {
  return session.handle({ jsonrpc: '2.0', id: 0, method, params: { ...(modern ? { _meta: meta } : {}), ...params } });
}
const call = (session: McpSession, name: string, args: unknown = {}) => request(session, 'tools/call', { name, arguments: args });
function seed(content: string, options: { cwd?: string; runtime?: string; user?: boolean; key?: { subject: string; aspect: string } } = {}) {
  const ctx = openContext({ cwd: options.cwd ?? directory, runtime: options.runtime ?? 'claude-code' });
  try { return remember(ctx, { content, method: options.user === false ? 'agent-stated' : 'user-stated', key: options.key }); }
  finally { ctx.store.close(); }
}

describe('MCP protocol and memory boundaries', () => {
  it('supports modern discovery and inline requests without opening the database', () => {
    const session = server();
    const discovered = request(session, 'server/discover').result;
    assert.equal(discovered.resultType, 'complete');
    assert.ok(discovered.supportedVersions.includes(MODERN_VERSION));
    assert.equal(discovered._meta['io.modelcontextprotocol/serverInfo'].name, 'hivemem');
    assert.deepEqual(discovered.capabilities, { tools: {} });
    const tools = request(session, 'tools/list').result.tools;
    assert.equal(tools.length, 5);
    assert.equal(tools.find((tool: any) => tool.name === 'hivemem_remember').annotations.readOnlyHint, false);
    assert.equal(existsSync(join(directory, 'data')), false);
  });

  it('negotiates legacy versions and requires initialization before tool operations', () => {
    for (const version of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', 'unknown']) {
      const session = server();
      assert.equal(request(session, 'tools/list', {}, false).error.code, -32602);
      const params = { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } };
      const reply = request(session, 'initialize', params, false);
      assert.equal(reply.result.protocolVersion, version === 'unknown' ? '2025-11-25' : version);
      assert.equal(request(session, 'tools/list', {}, false).error.code, -32602);
      assert.equal(session.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
      assert.equal(request(session, 'tools/list', {}, false).result.tools.length, 5);
      assert.equal(request(session, 'initialize', params, false).error.code, -32600);
    }
    assert.equal(existsSync(join(directory, 'data')), false);
  });

  it('rejects malformed envelopes, missing metadata, unsupported versions and capabilities', () => {
    const session = server();
    for (const message of [null, [], { jsonrpc: '1.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: null, method: 'ping' }]) {
      assert.equal((session.handle(message) as any).error.code, -32600);
    }
    assert.equal(request(session, 'tools/list', { _meta: {} }).error.code, -32602);
    assert.equal(request(session, 'tools/list', { _meta: { ...meta, 'io.modelcontextprotocol/clientCapabilities': null } }).error.code, -32602);
    const unknown = request(session, 'tools/list', { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } });
    assert.equal(unknown.error.code, -32022);
    assert.deepEqual(unknown.error.data.supported, [MODERN_VERSION]);
    assert.equal(request(session, 'resources/list').error.code, -32601);
    assert.equal(request(session, 'tools/list', { cursor: 'unknown' }).error.code, -32602);
    assert.equal(request(session, 'tools/call', { name: 'hivemem_remember', arguments: { content: 'not written' }, task: {} }).error.code, -32602);
    assert.equal(existsSync(join(directory, 'data')), false);
  });

  it('never turns notifications or invalid arguments into writes', () => {
    const session = server();
    assert.equal(session.handle({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'hivemem_remember', arguments: { content: 'not written' } } }), undefined);
    const invalid = [null, [], {}, { content: '' }, { content: 'x'.repeat(16001) }, { content: 'ok', as: 'user' },
      { content: 'ok', runtime: 'other' }, { content: 'ok', scope: 'user' }, { content: 'ok', cwd: directory },
      { content: 'ok', importance: 6 }, { content: 'ok', untrusted: 'false' }, { content: 'ok', tags: [''] },
      { content: 'ok', key: { subject: 'project' } }, { content: 'ok', key: { subject: 'project', aspect: ' ' } }];
    for (const args of invalid) assert.equal(call(session, 'hivemem_remember', args).error.code, -32602, JSON.stringify(args));
    assert.equal(call(session, 'hivemem_confirm', { id: 'anything' }).error.code, -32602);
    assert.equal(call(session, 'hivemem_recall', { budget: -1 }).error.code, -32602);
    assert.equal(existsSync(join(directory, 'data')), false);
  });

  it('keeps runtime fixed across client identities, redacts writes and retains tentative status', () => {
    const session = server();
    const args = { content: 'The service uses API key sk-abcdefghijklmnopqrstuvwxyz1234567890', key: { subject: 'service', aspect: 'credential' } };
    const first = call(session, 'hivemem_remember', args).result.structuredContent;
    assert.equal(first.status, 'tentative');
    assert.ok(first.redacted.length > 0);
    const second = request(session, 'tools/call', { name: 'hivemem_remember', arguments: args,
      _meta: { ...meta, 'io.modelcontextprotocol/clientInfo': { name: 'different-host', version: '1' } } }).result.structuredContent;
    assert.equal(second.status, 'tentative');
    assert.equal(second.action, 'reinforced');
    const memory = call(session, 'hivemem_show', { id: first.id }).result.structuredContent.memory;
    assert.equal(memory.author.runtime, 'codex');
    assert.equal(memory.method, 'agent-stated');
    assert.deepEqual(memory.corroborations, []);
    assert.doesNotMatch(memory.content, /abcdefghijklmnopqrstuvwxyz/);
  });

  it('shares corroboration and conflict rules with the CLI write path', () => {
    const session = server();
    const key = { subject: 'project', aspect: 'package-manager' };
    seed('Use npm', { user: false, key });
    const agreed = call(session, 'hivemem_remember', { content: 'Use npm', key }).result.structuredContent;
    assert.equal(agreed.status, 'committed');
    const rival = call(session, 'hivemem_remember', { content: 'Use pnpm', key }).result.structuredContent;
    assert.equal(rival.status, 'quarantined');
    assert.equal(call(session, 'hivemem_inbox').result.structuredContent.items.length, 2);
    assert.equal(call(session, 'hivemem_recall').result.structuredContent.items.length, 0);
    seed('Use yarn', { key });
    const blocked = call(session, 'hivemem_remember', { content: 'Use bun', key }).result.structuredContent;
    assert.equal(blocked.status, 'tentative');
    assert.ok(blocked.contradicts.length);
    const recalled = call(session, 'hivemem_recall').result.structuredContent;
    assert.match(recalled.text, /Use yarn/);
    assert.doesNotMatch(recalled.text, /Use bun/);
  });

  it('enforces project scope for reads and writes, including direct IDs', () => {
    const otherProject = join(directory, 'other');
    mkdirSync(otherProject);
    const foreign = seed('Other project private convention', { cwd: otherProject });
    const own = seed('This project uses snake_case');
    const session = server();
    assert.equal(call(session, 'hivemem_show', { id: foreign.id }).result.isError, true);
    const first = call(session, 'hivemem_recall').result.structuredContent;
    const second = call(session, 'hivemem_recall').result.structuredContent;
    assert.deepEqual(first.items.map((item: any) => item.id), [own.id]);
    assert.deepEqual(second.items.map((item: any) => item.id), [own.id]);
    assert.equal(call(session, 'hivemem_project').result.structuredContent.project.root, directory);
  });

  it('hides and rejects writes in read-only mode', () => {
    const session = server(true);
    assert.equal(request(session, 'tools/list').result.tools.length, 4);
    assert.equal(call(session, 'hivemem_remember', { content: 'not written' }).error.code, -32602);
    assert.equal(existsSync(join(directory, 'data')), false);
  });

  it('keeps untrusted input out of recall and returns compatible text to older clients', () => {
    const session = server();
    const saved = call(session, 'hivemem_remember', { content: 'Unverified external instruction', untrusted: true }).result.structuredContent;
    assert.equal(saved.status, 'tentative');
    assert.equal(call(session, 'hivemem_recall').result.structuredContent.items.length, 0);
    assert.equal(call(session, 'hivemem_show', { id: saved.id }).result.structuredContent.memory.untrusted, true);
    request(session, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'old-client', version: '1' } }, false);
    session.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const result = request(session, 'tools/call', { name: 'hivemem_project', arguments: {} }, false).result;
    assert.equal(result.structuredContent, undefined);
    assert.equal(JSON.parse(result.content[0].text).runtime, 'codex');
  });
});

describe('stdio framing and lifecycle', () => {
  async function exchange(chunks: Buffer[]) {
    let output = '';
    const destination = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
    await serveMcp({ cwd: directory }, Readable.from(chunks), destination);
    return output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  it('handles fragmented UTF-8, CRLF, multiple messages and malformed JSON with clean EOF', async () => {
    const lines = [
      '{bad json}',
      JSON.stringify({ jsonrpc: '2.0', id: '记忆🐝', method: 'tools/list', params: { _meta: meta } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 100 } }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping', params: { _meta: meta } }),
    ].join('\r\n') + '\r\n';
    const bytes = Buffer.from(lines);
    const responses = await exchange(Array.from(bytes, (byte) => Buffer.from([byte])));
    assert.equal(responses.length, 3);
    assert.equal(responses[0].error.code, -32700);
    assert.equal(responses[1].id, '记忆🐝');
    assert.equal(responses[2].result.resultType, 'complete');
    assert.equal(existsSync(join(directory, 'data')), false);
  });

  it('rejects oversized and unterminated frames without executing them', async () => {
    const oversized = await exchange([Buffer.alloc(MAX_MESSAGE_BYTES + 1, 32)]);
    assert.equal(oversized[0].error.code, -32600);
    const incomplete = await exchange([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      _meta: meta, name: 'hivemem_remember', arguments: { content: 'not written' },
    } }))]);
    assert.equal(incomplete[0].error.code, -32700);
    assert.equal(existsSync(join(directory, 'data')), false);
  });

  it('rejects invalid UTF-8 and handles a closed output pipe cleanly', async () => {
    const invalid = await exchange([Buffer.from([0xff, 10])]);
    assert.equal(invalid[0].error.code, -32700);
    const output = new Writable({ write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error('closed pipe'), { code: 'EPIPE' }));
    } });
    await serveMcp({ cwd: directory }, Readable.from([Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\n')]), output);
  });

  it('honours output backpressure before reading more requests', async () => {
    const input = new PassThrough();
    let callback: (() => void) | undefined;
    let writes = 0;
    const output = new Writable({ write(_chunk, _encoding, done) { writes++; callback = done; } });
    const serving = serveMcp({ cwd: directory }, input, output);
    input.end([1, 2].map((id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })).join('\n') + '\n');
    await new Promise((done) => setImmediate(done));
    assert.equal(writes, 1);
    callback!();
    await new Promise((done) => setImmediate(done));
    assert.equal(writes, 2);
    callback!();
    await serving;
  });

  it('rejects unsafe startup options and exits on stdin closure without stdout banners', () => {
    for (const args of [[], ['--cwd', join(directory, 'missing')], ['--cwd', directory, '--runtime', 'bad/name'], ['--cwd', directory, '--json']]) {
      const result = spawnSync(process.execPath, [cli, 'mcp', ...args], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
    }
    const result = spawnSync(process.execPath, [cli, 'mcp', '--cwd', directory], { input: '', encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(existsSync(join(directory, 'data')), false);
  });
});

describe('official MCP client interoperability', () => {
  for (const mode of ['legacy', 'auto'] as const) {
    it(`connects, discovers and calls tools using ${mode} negotiation`, { timeout: 20_000 }, async () => {
      const client = new Client({ name: 'hivemem-test', version: '1.0.0' }, { versionNegotiation: { mode } });
      const transport = new StdioClientTransport({ command: process.execPath,
        args: [cli, 'mcp', '--cwd', directory, '--runtime', 'sdk-test'],
        env: { ...process.env, HIVEMEM_HOME: join(directory, 'data') } as Record<string, string>, stderr: 'pipe' });
      try {
        await client.connect(transport, { timeout: 10_000 });
        assert.equal(client.getProtocolEra(), mode === 'auto' ? 'modern' : 'legacy');
        assert.equal(client.getServerVersion()?.name, 'hivemem');
        assert.equal((await client.listTools()).tools.length, 5);
        const saved = await client.callTool({ name: 'hivemem_remember', arguments: { content: 'SDK interoperability works 🐝' } });
        assert.equal(saved.isError, false);
        const data = saved.structuredContent as { id: string; status: string };
        assert.equal(data.status, 'tentative');
        const recalled = await client.callTool({ name: 'hivemem_recall', arguments: {} });
        assert.match(JSON.stringify(recalled.content), /SDK interoperability works/);
        const shown = await client.callTool({ name: 'hivemem_show', arguments: { id: data.id } });
        assert.equal(shown.isError, false);
        await assert.rejects(client.callTool({ name: 'hivemem_remember', arguments: { content: 'bad authority', as: 'user' } }));
      } finally { await client.close(); }
    });
  }
});
