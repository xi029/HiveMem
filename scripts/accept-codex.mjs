// Opt-in live-host acceptance: uses the existing Codex login and may consume model quota.
// No host settings are changed. A temporary project and memory store contain synthetic data only.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const write = args.includes('--write');
const index = args.indexOf('--bin');
const bin = index < 0 ? 'codex' : args[index + 1];
const known = args.filter((_, i) => i !== index && i !== index + 1);
if (!bin || (index < 0 ? args : known).some(arg => arg !== '--write')) {
  throw new Error('Usage: npm run test:host:codex -- [--bin /path/to/codex.exe] [--write]');
}
const cli = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'hivemem host 测试 ')));
const project = join(root, 'project');
const hostConfig = join(root, 'host');
mkdirSync(project); mkdirSync(hostConfig);
const env = { ...process.env, HIVEMEM_HOME: join(root, 'memory') };
const run = (...args) => execFileSync(process.execPath, [cli, ...args, '--cwd', project], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const report = { host: 'codex', version: null, date: new Date().toISOString(), platform: process.platform,
  configuration: false, project: false, recall: false, inbox: false, write: write ? 'pending' : 'not-requested', passed: false };
try {
  report.version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
  const seeded = JSON.parse(run('remember', 'Acceptance convention: API fields use snake_case.', '--as', 'user', '--json'));
  const configFile = join(hostConfig, 'config.toml');
  run('setup', '--mcp', '--target', 'codex', '--output', configFile, ...(write ? [] : ['--read-only']));
  // Have the real host parse the generated TOML before attempting any model call.
  const parsed = JSON.parse(execFileSync(bin, ['mcp', 'get', 'hivemem', '--json'], {
    env: { ...env, CODEX_HOME: hostConfig }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  assert.equal(parsed.transport.command, process.execPath);
  assert.ok(parsed.transport.args.includes(project));
  report.configuration = true;
  const q = value => JSON.stringify(value).replaceAll('\x7f', '\\u007f');
  const { command, args: serverArgs } = parsed.transport;
  const override = `mcp_servers={hivemem={command=${q(command)},args=[${serverArgs.map(q).join(',')}],env={HIVEMEM_HOME=${q(env.HIVEMEM_HOME)}},required=true}}`;
  const content = 'Host acceptance observation: smoke tests run with npm test.';
  const prompt = 'Integration acceptance test. Use only hivemem MCP tools, without shell commands or file reads. '
    + 'Call hivemem_project, then hivemem_recall with query "Acceptance convention". '
    + (write ? `Then call hivemem_remember with content exactly ${q(content)}. ` : '')
    + 'Finally call hivemem_inbox and report results. Do not attempt alternate tools if approval is denied.';
  const events = await new Promise((resolve, reject) => {
    const child = spawn(bin, ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
      '-C', project, '--json', '-c', override, prompt], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 180_000);
    child.stdout.on('data', data => { output += data; });
    child.stderr.resume(); // Host diagnostics may contain local settings; do not publish them.
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut || code !== 0) return reject(new Error(timedOut ? 'Host timed out' : `Host exited with code ${code}; check login and host configuration`));
      try { resolve(output.split('\n').filter(Boolean).map(line => JSON.parse(line))); }
      catch { reject(new Error('Host returned invalid JSONL events')); }
    });
  });
  const completed = events.filter(event => event.type === 'item.completed' && event.item?.type === 'mcp_tool_call').map(event => event.item);
  const result = name => {
    const item = completed.find(item => item.server === 'hivemem' && item.tool === name && item.status === 'completed' && !item.error);
    assert.ok(item && item.result && !item.result.is_error && !item.result.isError, `Host did not complete ${name}; check tool approval policy`);
    return item.result.structured_content ?? JSON.parse(item.result.content.find(part => part.type === 'text').text);
  };
  assert.equal(result('hivemem_project').project.root, project); report.project = true;
  const recalled = result('hivemem_recall');
  assert.match(recalled.text, /API fields use snake_case/);
  const verified = JSON.parse(execFileSync(process.execPath, [cli, 'doctor', '--mcp', '--expect-id', seeded.id, '--json'], {
    cwd: project, env, input: JSON.stringify(recalled), encoding: 'utf8',
  }));
  assert.equal(verified.recallVerified, true); report.recall = true;
  const inbox = result('hivemem_inbox'); report.inbox = true;
  if (write) {
    const saved = result('hivemem_remember');
    assert.equal(saved.status, 'tentative');
    assert.ok(inbox.items.some(item => item.id === saved.id));
    const stored = JSON.parse(run('show', saved.id, '--json')).memory;
    assert.equal(stored.status, 'tentative');
    assert.equal(stored.content, content);
    assert.equal(stored.author.runtime, 'codex');
    report.write = 'passed';
  }
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  console.log(JSON.stringify(report, null, 2));
  rmSync(root, { recursive: true, force: true });
}
