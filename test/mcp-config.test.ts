import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const cli = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

test('generated JSON launches a usable read-only server with canonical paths and an isolated store', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'hivemem config 测试 ')));
  const home = join(directory, 'memory');
  const output = join(directory, 'mcp.json');
  const client = new Client({ name: 'config-test', version: '1' });
  try {
    execFileSync(process.execPath, [cli, 'setup', '--mcp', '--target', 'claude-code', '--cwd', directory,
      '--read-only', '--output', output], { env: { ...process.env, HIVEMEM_HOME: home } });
    assert.equal(existsSync(home), false);
    const server = JSON.parse(readFileSync(output, 'utf8')).mcpServers.hivemem;
    assert.equal(server.args[0], cli);
    const transport = new StdioClientTransport({ ...server, stderr: 'pipe' });
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.some(t => t.name === 'hivemem_remember'), false);
    const result = await client.callTool({ name: 'hivemem_project', arguments: {} });
    const project = JSON.parse((result.content as { text: string }[])[0]!.text);
    assert.equal(project.project.root, directory);
    assert.equal(project.runtime, 'claude-code');
    assert.equal(project.readOnly, true);
    assert.equal(existsSync(join(home, 'hivemem.db')), true);
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('MCP setup refuses ambiguous options and cannot overwrite an existing config', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hivemem-config-'));
  try {
    const output = join(directory, 'existing.json');
    writeFileSync(output, '{"foreign":true}\r\n');
    const base = [cli, 'setup', '--mcp', '--target', 'generic', '--cwd', directory];
    for (const args of [
      [...base, '--output', output], [...base, '--apply'], [...base, '--json'],
      [...base, '--target', 'codex,claude-code'], [...base, '--cwd', output],
      [cli, 'setup', '--mcp', '--target', 'codex'],
    ]) {
      assert.notEqual(spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, HIVEMEM_HOME: join(directory, 'memory') } }).status, 0);
      assert.equal(readFileSync(output, 'utf8'), '{"foreign":true}\r\n');
      assert.equal(existsSync(join(directory, 'memory')), false);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
