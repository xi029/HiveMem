import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { checkHost, checkRecall, readReport } from '../src/mcp/diagnose.ts';

test('host discovery, consent and transport status never imply recall', () => {
  const pending = checkHost('hivemem:\r\n  Status: ⏸ Pending approval (run `claude` to approve)\r\n  Environment: private-value', 'claude-code');
  assert.equal(pending.state, 'pending-approval');
  assert.equal(pending.recallVerified, false);
  assert.ok(!JSON.stringify(pending).includes('private-value'));
  assert.equal(checkHost('other:\n Status: ✓ Connected', 'claude-code').state, 'unknown');
  assert.equal(checkHost('hivemem:\n Status: ✓ Connected', 'claude-code').recallVerified, false);
  assert.equal(checkHost('hivemem:\n Status: unrecognized', 'claude-code').state, 'unknown');
  assert.equal(checkHost('Error: No MCP server named \'hivemem\' found.', 'codex').state, 'not-found');
  assert.equal(checkHost('{"name":"hivemem","enabled":false}', 'codex').state, 'disabled');
  assert.equal(checkHost('{"name":"hivemem","enabled":true,"transport":{"type":"stdio"}}', 'codex').state, 'configured');
});

test('a matching ID must appear in recall items with its line in rendered memory', async () => {
  const id = '01M7PRJXBETCY9XNF420J5XQNV';
  const data = { items: [{ id, line: '- Example convention' }], text: 'Header\n- Example convention\nFooter' };
  for (const result of [data, { structured_content: data }, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(data) }] } }]) {
    assert.equal(checkRecall(JSON.stringify(result), id).recallVerified, true);
  }
  for (const result of [{ is_error: true, structured_content: data }, { ...data, text: '' }, { items: [{ id }] }, { text: id }, { ...data, items: [] }]) {
    assert.equal(checkRecall(JSON.stringify(result), id).recallVerified, false);
  }
  assert.equal(checkRecall(JSON.stringify(data), '01M7PRJXBETCY9XNF420J5XQNA').recallVerified, false);
  assert.throws(() => checkRecall('', 'short'), /full 26-character ID/);
  await assert.rejects(readReport(Readable.from([Buffer.alloc(1024 * 1024), 'a'])), /exceeds/);
});
