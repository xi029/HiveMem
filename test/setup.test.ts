import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { doctor, setup } from '../src/hooks/install.ts';
import { configPath, hookConfig, TARGETS, type Target } from '../src/hooks/setup.ts';

let directory: string;
const cli = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
const launcher = { node: process.execPath, cli };
const foreign = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo existing' }] };
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'hivemem-setup-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));

describe('managed hook installation', () => {
  for (const target of Object.keys(TARGETS) as Target[]) {
    it(`${target}: preserves settings, backs up exact bytes, is idempotent, and ejects only owned hooks`, () => {
      const config = join(directory, 'settings.json');
      const original = { permissions: { allow: ['Read'] }, hooks: { SessionStart: [foreign], Stop: [] } };
      const originalText = JSON.stringify(original, null, 4) + '\r\n';
      writeFileSync(config, originalText);
      const options = { target, config, launcher, action: 'apply' as const };
      const applied = setup(options);
      assert.equal(applied.changed, true);
      assert.equal(readFileSync(applied.backups[0]!, 'utf8'), originalText);
      const installed = json(config);
      assert.deepEqual(installed.permissions, original.permissions);
      assert.deepEqual(installed.hooks.SessionStart[0], foreign);
      assert.equal(installed.hooks.SessionStart.length, 2);
      assert.deepEqual(Object.keys(hookConfig(target, launcher).hooks), ['SessionStart', 'UserPromptSubmit']);
      assert.equal(doctor(target, config).ok, true);

      // Edits made after installation are kept, including hook ordering.
      installed.theme = 'dark';
      installed.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'echo added-later' }] });
      write(config, installed);
      const before = readFileSync(config, 'utf8');
      const files = readdirSync(directory);
      assert.equal(setup(options).changed, false);
      assert.equal(readFileSync(config, 'utf8'), before);
      assert.deepEqual(readdirSync(directory), files);

      const removed = setup({ ...options, action: 'eject' });
      assert.equal(removed.changed, true);
      assert.deepEqual(json(config), { ...original, theme: 'dark', hooks: {
        ...original.hooks, SessionStart: [foreign, installed.hooks.SessionStart[2]],
      } });
      assert.equal(existsSync(`${config}.hivemem.json`), false);
      assert.equal(setup({ ...options, action: 'eject' }).changed, false);
    });
  }

  it('dry-run and doctor never create a directory or memory store', () => {
    const config = join(directory, 'absent', 'settings.json');
    const result = setup({ target: 'claude-code', config, launcher, action: 'apply', dryRun: true });
    assert.equal(result.changed, true);
    assert.ok(result.config?.hooks);
    assert.equal(doctor('claude-code', config).ok, false);
    assert.deepEqual(readdirSync(directory), []);
  });

  it('updates relocated launchers and restores an originally empty configuration', () => {
    const config = join(directory, 'new.json');
    const options = { target: 'claude-code' as const, config, launcher, action: 'apply' as const };
    setup(options);
    const moved = { node: process.execPath, cli: join(directory, 'missing.js') };
    setup({ ...options, launcher: moved });
    assert.equal(doctor('claude-code', config).ok, false);
    assert.equal(json(config).hooks.SessionStart.length, 1);
    setup(options);
    assert.equal(doctor('claude-code', config).ok, true);
    setup({ ...options, action: 'eject' });
    assert.deepEqual(json(config), {});
  });

  it('refuses malformed settings without writing backups or normalizing their contents', () => {
    const config = join(directory, 'bad.json');
    for (const text of ['{ // comments\n}', '[]', '{"hooks":null}', '{"hooks":{"SessionStart":{}}}']) {
      writeFileSync(config, text);
      assert.throws(() => setup({ target: 'codex', config, launcher, action: 'apply' }));
      assert.equal(readFileSync(config, 'utf8'), text);
      assert.deepEqual(readdirSync(directory), ['bad.json']);
      assert.equal(doctor('codex', config).ok, false);
    }
  });

  it('upgrades previously recorded commands when the generator changes', () => {
    const config = join(directory, 'settings.json');
    const options = { target: 'claude-code' as const, config, launcher, action: 'apply' as const };
    setup(options);
    const previous = json(config);
    const record = json(`${config}.hivemem.json`);
    previous.hooks.SessionStart[0].hooks[0].timeout = 5;
    record.hooks = previous.hooks;
    write(config, previous);
    write(`${config}.hivemem.json`, record);
    assert.equal(doctor('claude-code', config).ok, true);
    assert.equal(setup(options).changed, true);
    assert.equal(json(config).hooks.SessionStart.length, 1);
    assert.equal(json(config).hooks.SessionStart[0].hooks[0].timeout, 10);
  });

  it('refuses edited, missing or duplicated owned hooks instead of overwriting them', () => {
    const config = join(directory, 'settings.json');
    const options = { target: 'claude-code' as const, config, launcher, action: 'apply' as const };
    setup(options);
    const installed = json(config);
    for (const entries of [[], [foreign], [...installed.hooks.SessionStart, ...installed.hooks.SessionStart]]) {
      write(config, { ...installed, hooks: { ...installed.hooks, SessionStart: entries } });
      const before = readFileSync(config, 'utf8');
      const files = readdirSync(directory);
      assert.throws(() => setup(options), /changed, removed or duplicated/);
      assert.throws(() => setup({ ...options, action: 'eject' }), /changed, removed or duplicated/);
      assert.equal(doctor('claude-code', config).ok, false);
      assert.equal(readFileSync(config, 'utf8'), before);
      assert.deepEqual(readdirSync(directory), files);
    }
  });

  it('does not adopt or delete manually installed hooks', () => {
    const config = join(directory, 'settings.json');
    write(config, hookConfig('claude-code', launcher));
    const options = { target: 'claude-code' as const, config, launcher, action: 'apply' as const };
    assert.throws(() => setup(options), /unmanaged/);
    assert.equal(setup({ ...options, action: 'eject' }).changed, false);
    assert.equal(doctor('claude-code', config).ok, false);
    assert.deepEqual(readdirSync(directory), ['settings.json']);
  });

  it('rejects an installation record for a different host and detects disabled hooks', () => {
    const config = join(directory, 'settings.json');
    setup({ target: 'claude-code', config, launcher, action: 'apply' });
    assert.throws(() => setup({ target: 'codex', config, launcher, action: 'apply' }), /incompatible/);
    write(config, { ...json(config), disableAllHooks: true });
    const report = doctor('claude-code', config);
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((check) => check.name === 'enabled' && check.status === 'error'));
  });

  it('honours a concurrent installer lock', () => {
    const config = join(directory, 'settings.json');
    writeFileSync(`${config}.hivemem.lock`, '');
    assert.throws(() => setup({ target: 'claude-code', config, launcher, action: 'apply' }), /lock exists/);
    assert.equal(existsSync(config), false);
    assert.deepEqual(readdirSync(directory), ['settings.json.hivemem.lock']);
  });

  it('refuses configuration symlinks instead of replacing them', (t) => {
    const config = join(directory, 'settings.json');
    const real = join(directory, 'real.json');
    write(real, {});
    try { symlinkSync(real, config); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('Windows symlink privilege unavailable');
      throw error;
    }
    assert.throws(() => setup({ target: 'claude-code', config, launcher, action: 'apply' }), /real path/);
    assert.deepEqual(json(real), {});
  });

  it('respects CODEX_HOME without writing there', () => {
    const previous = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = join(directory, 'codex-home');
      assert.equal(configPath('codex'), join(directory, 'codex-home', 'hooks.json'));
      assert.deepEqual(readdirSync(directory), []);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });
});

describe('generated launchers', () => {
  it('preserves argv and stdin through each host execution model, including special characters in paths', () => {
    const nested = join(directory, "space ' & $ ` path");
    mkdirSync(nested);
    const fixture = join(nested, 'entry.cjs');
    writeFileSync(fixture, "process.stdout.write(JSON.stringify({args: process.argv.slice(2), input: require('node:fs').readFileSync(0, 'utf8')}));");
    for (const target of Object.keys(TARGETS) as Target[]) {
      const config = hookConfig(target, { node: process.execPath, cli: fixture });
      const command = config.hooks.SessionStart![0]!.hooks[0]!;
      const options = { encoding: 'utf8' as const, input: '{"prompt":"literal input"}', timeout: 15_000 };
      let result;
      if (target === 'claude-code') result = spawnSync(command.command, command.args!, options);
      else if (process.platform === 'win32' && target === 'codex') result = spawnSync(command.commandWindows!, { ...options, shell: true });
      else {
        const shell = process.platform === 'win32'
          ? resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe')
          : '/bin/sh';
        result = spawnSync(shell, ['-c', command.command], options);
      }
      assert.equal(result.status, 0, `${target}: ${result.error ?? result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), { args: ['hook', 'SessionStart', '--runtime', target], input: options.input });
    }
  });

  it('rejects unsafe cmd.exe expansions rather than silently changing a path', () => {
    const dangerous = { node: process.execPath, cli: join(directory, '%TEMP%', 'entry.js') };
    assert.throws(() => hookConfig('codex', dangerous, 'win32'), /installation paths/);
    assert.doesNotThrow(() => hookConfig('claude-code', dangerous, 'win32'));
  });
});

describe('setup public CLI', () => {
  it('supports preview, install, diagnosis and eject without creating a memory store', () => {
    const config = join(directory, 'settings.json');
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8', timeout: 15_000, cwd: directory,
      env: { ...process.env, HIVEMEM_HOME: join(directory, 'data') },
    });
    const invalid = [
      ['setup', '--apply'], ['setup', '--target', 'typo'], ['setup', '--apply', '--target', 'codex,claude-code'],
      ['setup', '--apply', '--eject', '--target', 'codex'], ['setup', '--aply', 'true'],
      ['setup', '--apply', '--target', 'codex', '--bin', 'custom'], ['doctor', '--config', config],
    ];
    for (const args of invalid) assert.equal(run(...args).status, 1, args.join(' '));
    assert.deepEqual(readdirSync(directory), []);
    const args = ['--target', 'claude-code', '--config', config, '--json'];
    assert.equal(JSON.parse(run('setup', '--apply', '--dry-run', ...args).stdout).dryRun, true);
    assert.deepEqual(readdirSync(directory), []);
    assert.equal(run('setup', '--apply', ...args).status, 0);
    const report = run('doctor', ...args);
    assert.equal(report.status, 0, report.stderr);
    assert.equal(JSON.parse(report.stdout)[0].ok, true);
    assert.equal(run('setup', '--eject', ...args).status, 0);
    assert.equal(run('doctor', ...args).status, 1);
    assert.equal(existsSync(join(directory, 'data')), false);
  });
});
