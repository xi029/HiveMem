// Opt-in live-host acceptance: uses the existing Codex login and may consume model quota.
// No host settings are changed. A temporary project and memory store contain synthetic data only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextCheck, watchCodex } from './watch-codex.mjs';

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
const run = (...args) => execFileSync(process.execPath, [cli, ...args, '--cwd', project], { env, timeout: 15_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const progress = { hostStarted: false, threadStarted: false, turnStarted: false, serverLaunched: false, protocolReplied: false, toolsListed: false, lastTool: null, lastToolState: null };
const report = { host: 'codex', version: null, date: new Date().toISOString(), platform: process.platform,
  configuration: false, project: false, recall: false, inbox: false, write: write ? 'pending' : 'not-requested', progress, passed: false };
let stage = 'host version check';
let savedId;
try {
  report.version = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  stage = 'local fixture setup';
  const seeded = JSON.parse(run('remember', 'Acceptance convention: API fields use snake_case.', '--as', 'user', '--json'));
  const configFile = join(hostConfig, 'config.toml');
  run('setup', '--mcp', '--target', 'codex', '--output', configFile, ...(write ? [] : ['--read-only']));
  // Have the real host parse the generated TOML before attempting any model call.
  stage = 'configuration check';
  const parsed = JSON.parse(execFileSync(bin, ['mcp', 'get', 'hivemem', '--json'], {
    env: { ...env, CODEX_HOME: hostConfig }, timeout: 15_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  assert.equal(parsed.transport.command, process.execPath);
  assert.ok(parsed.transport.args.includes(project));
  report.configuration = true;
  const q = value => JSON.stringify(value).replaceAll('\x7f', '\\u007f');
  const { command, args: serverArgs } = parsed.transport;
  const observedArgs = ['--import', new URL('./host-probe.mjs', import.meta.url).href, ...serverArgs];
  const override = `mcp_servers={hivemem={command=${q(command)},args=[${observedArgs.map(q).join(',')}],env={HIVEMEM_HOME=${q(env.HIVEMEM_HOME)},HIVEMEM_ACCEPT_DIR=${q(hostConfig)}},required=true}}`;
  const content = 'Host acceptance observation: smoke tests run with npm test.';
  const prompt = 'Integration acceptance test. Use only hivemem MCP tools, without shell commands or file reads. '
    + 'Call hivemem_project, then hivemem_recall with query "Acceptance convention". '
    + (write ? `Then call hivemem_remember with content exactly ${q(content)}. ` : '')
    + 'Finally call hivemem_inbox and report results. Do not attempt alternate tools if approval is denied.';
  stage = 'live session';
  let inboxIds = [];
  await watchCodex(bin, ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
    '-C', project, '--json', '-c', override, prompt], { cwd: project, env }, progress, (name, data) => {
    if (name === 'hivemem_project') {
      assert.equal(data.project.root, project); report.project = true;
    } else if (name === 'hivemem_recall') {
      assert.match(data.text, /API fields use snake_case/);
      const verified = JSON.parse(execFileSync(process.execPath, [cli, 'doctor', '--mcp', '--expect-id', seeded.id, '--json'], {
        cwd: project, env, input: JSON.stringify(data), timeout: 15_000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      }));
      assert.equal(verified.recallVerified, true); report.recall = true;
    } else if (name === 'hivemem_inbox') {
      inboxIds = data.items.map(item => item.id); report.inbox = true;
    } else {
      assert.ok(write); assert.equal(data.status, 'tentative'); assert.ok(data.id); savedId = data.id;
    }
  });
  for (const required of ['project', 'recall', 'inbox']) if (!report[required]) throw new Error(`Missing verified hivemem_${required} result`);
  if (write) {
    stage = 'independent write verification';
    assert.ok(savedId && inboxIds.includes(savedId));
    const stored = JSON.parse(run('show', savedId, '--json')).memory;
    assert.equal(stored.status, 'tentative');
    assert.equal(stored.content, content);
    assert.equal(stored.author.runtime, 'codex');
    report.write = 'passed';
  }
  report.passed = true;
} catch (error) {
  report.error = stage === 'live session' ? error.message : `Failed during ${stage}`;
  process.exitCode = 1;
} finally {
  progress.serverLaunched = existsSync(join(hostConfig, 'server-launched'));
  progress.protocolReplied = existsSync(join(hostConfig, 'protocol-replied'));
  progress.toolsListed = existsSync(join(hostConfig, 'tools-listed'));
  if (!report.passed) report.nextCheck = nextCheck(report, stage, savedId);
  try {
    if (dirname(root) !== realpathSync(tmpdir())) throw new Error('Unexpected temp directory');
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    report.cleanup = 'removed';
  } catch {
    report.cleanup = 'temporary-directory-retained';
    report.passed = false;
    report.error ??= 'Temporary directory cleanup failed';
    process.exitCode = 1;
  }
  console.log(JSON.stringify(report, null, 2));
}
