import { stripVTControlCharacters } from 'node:util';
import { isObject } from './tools.ts';

type State = 'configured' | 'connected' | 'pending-approval' | 'disabled' | 'failed' | 'not-found' | 'unknown' | 'recall-matched' | 'recall-unverified';

function report(state: State, next: string) {
  return { state, recallVerified: state === 'recall-matched', next };
}

function decode(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

export function checkRecall(input: string, expected: string) {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(expected)) throw new Error('--expect-id needs the full 26-character ID from `hivemem show <short-id>`');
  const parsed = decode(input.trim());
  const result = isObject(parsed) && parsed.jsonrpc === '2.0' ? (parsed.error ? undefined : parsed.result) : parsed;
  if (isObject(result) && !result.isError && !result.is_error && !result.error) {
    const block = Array.isArray(result.content) ? result.content.find(part => isObject(part) && part.type === 'text' && typeof part.text === 'string') : undefined;
    const data = result.structuredContent ?? result.structured_content ?? (block ? decode(block.text) : result);
    if (isObject(data) && typeof data.text === 'string' && Array.isArray(data.items)) {
      const text = data.text;
      if (data.items.some(item => isObject(item) && item.id === expected.toUpperCase() && typeof item.line === 'string' && item.line.length > 0 && text.includes(item.line))) {
        return report('recall-matched', 'The supplied recall result contains the expected memory ID and its rendered line.');
      }
    }
  }
  return report('recall-unverified', 'Copy the actual hivemem_recall tool result as JSON. Check the project, store, search keyword and full memory ID.');
}

export function checkHost(input: string, target: string) {
  const text = stripVTControlCharacters(input).trim();
  const config = 'Generate the configuration with `hivemem setup --mcp` and load it in this host.';
  const recall = 'In the host, call hivemem_recall for a known convention. Check its tool result with `hivemem doctor --mcp --expect-id <full-id>`.';
  if (target === 'codex') {
    const data = decode(text);
    if (isObject(data) && data.name === 'hivemem' && typeof data.enabled === 'boolean') {
      if (!data.enabled) return report('disabled', 'Review the disabled hivemem entry in your Codex configuration.');
      if (isObject(data.transport) && data.transport.type === 'stdio') return report('configured', `Codex lists the stdio entry. ${recall}`);
    }
    if (/^(?:error:\s*)?no mcp server named ['"]?hivemem['"]? found\.?$/im.test(text)) return report('not-found', config);
  } else if (target === 'claude-code') {
    if (/^No MCP server named "hivemem"\./m.test(text)) return report('not-found', config);
    const section = /^hivemem:[ \t]*\r?\n((?:[ \t]+[^\n]*(?:\n|$))*)/m.exec(text)?.[1];
    if (section) {
      const status = /^[ \t]*Status:[ \t]*(.+)$/mi.exec(section)?.[1]?.trim();
      if (status && /^(?:⏸\s*)?pending approval\b/i.test(status)) return report('pending-approval', 'Open Claude Code in this project and review the hivemem server before retrying.');
      if (status && /^(?:✓\s*)?connected\b/i.test(status)) return report('connected', `Claude Code reports a connection. ${recall}`);
      if (status && /^(?:✗\s*)?failed to connect\b/i.test(status)) return report('failed', 'Check the configured Node, HiveMem and project paths, then retry the host check.');
    }
  } else throw new Error('choose --target claude-code or codex');
  return report('unknown', `Unrecognized host report. Run ${target === 'codex' ? 'codex mcp get hivemem --json' : 'claude mcp get hivemem'} in the intended project and pipe its output here.`);
}

export async function readReport(input: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024 * 1024) throw new Error('MCP report exceeds 1 MiB; provide only the server status or one recall tool result');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}
