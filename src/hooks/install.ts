import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { configPath, EVENTS, hookConfig, type HookConfig, type Launcher, type Target, TARGETS, validateLauncher } from './setup.ts';

type ObjectValue = Record<string, unknown>;
interface Snapshot { text: string; mode: number }
interface Manifest {
  version: 1;
  target: Target;
  launcher: Launcher;
  hooks: HookConfig['hooks'];
  hadHooks: boolean;
  hadEvents: string[];
}
export interface SetupOptions {
  target: Target;
  config?: string;
  action: 'apply' | 'eject';
  dryRun?: boolean;
  launcher: Launcher;
}

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function read(path: string): Snapshot | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${path}: expected a regular file; for symlinks use --config with the real path`);
    return { text: readFileSync(path, 'utf8'), mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function parse(snapshot: Snapshot | undefined, path: string): ObjectValue {
  if (!snapshot) return {};
  let value: unknown;
  try { value = JSON.parse(snapshot.text); } catch { throw new Error(`${path}: expected strict JSON (comments and trailing commas are not supported); nothing was changed`); }
  if (!object(value)) throw new Error(`${path}: expected a JSON object`);
  return value;
}

function hooksOf(config: ObjectValue): Record<string, unknown[]> {
  if (!Object.hasOwn(config, 'hooks')) return {};
  if (!object(config.hooks) || Object.values(config.hooks).some((entries) => !Array.isArray(entries))) {
    throw new Error('hooks must be an object whose event values are arrays; nothing was changed');
  }
  return config.hooks as Record<string, unknown[]>;
}

function manifestOf(snapshot: Snapshot | undefined, path: string, target: Target): Manifest | undefined {
  if (!snapshot) return undefined;
  const data = parse(snapshot, path);
  if (data.version !== 1 || data.target !== target || typeof data.hadHooks !== 'boolean'
    || !Array.isArray(data.hadEvents) || data.hadEvents.some((event) => !EVENTS.includes(event))) {
    throw new Error(`${path}: invalid or incompatible HiveMem installation record`);
  }
  validateLauncher(data.launcher as Launcher);
  const hooks = hooksOf(data);
  if (Object.keys(hooks).length !== EVENTS.length || EVENTS.some((event) => {
    const entries = hooks[event];
    if (!entries || entries.length !== 1 || !object(entries[0])) return true;
    const commands = entries[0].hooks;
    return !Array.isArray(commands) || commands.length !== 1 || !object(commands[0])
      || commands[0].type !== 'command' || typeof commands[0].command !== 'string';
  })) throw new Error(`${path}: invalid managed hook entries`);
  return data as unknown as Manifest;
}

function removeOwned(hooks: Record<string, unknown[]>, manifest: Manifest): Record<string, number> {
  // Keep the original bytes' structure in the record so future generators can upgrade old hooks.
  const owned = manifest.hooks;
  const positions: Record<string, number> = {};
  for (const event of EVENTS) {
    const entries = hooks[event] ?? [];
    const matches = entries.filter((entry) => isDeepStrictEqual(entry, owned[event]![0]));
    if (matches.length !== 1) {
      throw new Error(`${event}: managed hook was changed, removed or duplicated. Restore it from the installation backup before retrying; nothing was changed`);
    }
    positions[event] = entries.findIndex((entry) => isDeepStrictEqual(entry, owned[event]![0]));
    hooks[event] = entries.filter((entry) => !isDeepStrictEqual(entry, owned[event]![0]));
  }
  return positions;
}

function unmanagedHook(hooks: Record<string, unknown[]>): boolean {
  return Object.values(hooks).flat().some((entry) => {
    if (!object(entry) || !Array.isArray(entry.hooks)) return false;
    return entry.hooks.some((hook: unknown) => {
      if (!object(hook)) return false;
      const command = [hook.command, hook.commandWindows, ...(Array.isArray(hook.args) ? hook.args : [])].join(' ');
      return /\bhivemem\b/i.test(command) || /\bhook\b.*\b(?:SessionStart|UserPromptSubmit)\b.*--runtime\b/.test(command);
    });
  });
}

function plan(options: SetupOptions) {
  const path = configPath(options.target, options.config);
  const recordPath = `${path}.hivemem.json`;
  const original = read(path);
  const originalRecord = read(recordPath);
  const config = parse(original, path);
  const hooks = hooksOf(config);
  const installed = manifestOf(originalRecord, recordPath, options.target);
  const positions = installed ? removeOwned(hooks, installed) : {};
  if (!installed && options.action === 'apply' && unmanagedHook(hooks)) {
    throw new Error('Existing unmanaged HiveMem hooks found. Remove those entries manually before using --apply; nothing was changed');
  }
  let record: Manifest | undefined;
  if (options.action === 'apply') {
    const generated = hookConfig(options.target, options.launcher);
    record = { version: 1, target: options.target, launcher: options.launcher, hooks: generated.hooks,
      hadHooks: installed?.hadHooks ?? Object.hasOwn(config, 'hooks'),
      hadEvents: installed?.hadEvents ?? EVENTS.filter((event) => Object.hasOwn(hooks, event)) };
    for (const event of EVENTS) {
      const entries = hooks[event] ?? [];
      entries.splice(positions[event] ?? entries.length, 0, ...generated.hooks[event]!);
      hooks[event] = entries;
    }
    config.hooks = hooks;
  } else if (installed) {
    for (const event of EVENTS) if (!hooks[event]?.length && !installed.hadEvents.includes(event)) delete hooks[event];
    if (!Object.keys(hooks).length && !installed.hadHooks) delete config.hooks;
  }
  const changed = !isDeepStrictEqual(config, parse(original, path)) || !isDeepStrictEqual(record, installed);
  return { path, recordPath, original, originalRecord, config, record, changed };
}

function serialize(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }

/** Each file replacement is atomic. Backups cover the two-file installation record. */
function replace(path: string, text: string, mode: number): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function setup(options: SetupOptions) {
  let prepared = plan(options);
  const result = { action: options.action, target: options.target, configPath: prepared.path,
    changed: prepared.changed, dryRun: !!options.dryRun, backups: [] as string[],
    note: options.action === 'apply' ? TARGETS[options.target].note : 'Only managed HiveMem hooks are removed; memories are retained.',
    ...(options.dryRun ? { config: prepared.config } : {}) };
  if (options.dryRun || !prepared.changed) return result;

  mkdirSync(dirname(prepared.path), { recursive: true });
  const lockPath = `${prepared.path}.hivemem.lock`;
  let lock: number;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Installation lock exists: ${lockPath}. If no setup process is running, remove the stale lock and retry`);
    throw error;
  }
  try {
    prepared = plan(options);
    result.changed = prepared.changed;
    if (!prepared.changed) return result;
    for (const [path, snapshot] of [[prepared.path, prepared.original], [prepared.recordPath, prepared.originalRecord]] as const) {
      if (!snapshot) continue;
      const backup = `${path}.${randomUUID()}.bak`;
      writeFileSync(backup, snapshot.text, { flag: 'wx', mode: 0o600 });
      result.backups.push(backup);
    }
    if (!isDeepStrictEqual(read(prepared.path), prepared.original) || !isDeepStrictEqual(read(prepared.recordPath), prepared.originalRecord)) {
      throw new Error('Configuration changed during setup; retry after the other editor has finished');
    }
    const newText = serialize(prepared.config);
    replace(prepared.path, newText, prepared.original?.mode ?? 0o600);
    try {
      if (prepared.record) replace(prepared.recordPath, serialize(prepared.record), 0o600);
      else if (prepared.originalRecord) unlinkSync(prepared.recordPath);
    } catch (error) {
      // Roll back only our own output, never a subsequent edit by another application.
      if (read(prepared.path)?.text === newText) {
        if (prepared.original) replace(prepared.path, prepared.original.text, prepared.original.mode);
        else unlinkSync(prepared.path);
      }
      throw new Error(`Could not update the installation record. Check configuration and backups: ${result.backups.join(', ')}`, { cause: error });
    }
    return result;
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

export interface Check { name: string; status: 'ok' | 'warning' | 'error'; message: string }

/** Configuration inspection only: never executes commands from an untrusted host config. */
export function doctor(target: Target, override?: string) {
  const path = configPath(target, override);
  const checks: Check[] = [];
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  checks.push({ name: 'node', status: major > 22 || (major === 22 && minor >= 18) ? 'ok' : 'error', message: `Node ${process.versions.node}; requires >=22.18` });
  try {
    const original = read(path);
    const config = parse(original, path);
    const hooks = hooksOf(config);
    checks.push({ name: 'config', status: original ? 'ok' : 'error', message: original ? 'Valid JSON hook configuration' : 'Configuration file does not exist; run setup --apply' });
    const record = manifestOf(read(`${path}.hivemem.json`), `${path}.hivemem.json`, target);
    if (!record) {
      checks.push({ name: 'installation', status: 'error', message: 'No managed installation record. Manual hooks cannot be verified; use the setup guide to migrate them' });
    } else {
      removeOwned(hooks, record);
      checks.push({ name: 'installation', status: 'ok', message: 'Both managed hooks match the installation record' });
      for (const [name, location] of Object.entries(record.launcher)) {
        let present = false;
        try { present = statSync(location).isFile(); } catch { /* missing launcher */ }
        checks.push({ name, status: present ? 'ok' : 'error', message: present ? location : `${location} is missing; rerun setup --apply from the new installation` });
      }
    }
    if (config.disableAllHooks === true) checks.push({ name: 'enabled', status: 'error', message: 'disableAllHooks is true in this configuration' });
    if (existsSync(`${path}.hivemem.lock`)) checks.push({ name: 'lock', status: 'warning', message: 'An installation lock exists; another setup may be running or a previous setup was interrupted' });
  } catch (error) {
    checks.push({ name: 'configuration', status: 'error', message: (error as Error).message });
  }
  checks.push({ name: 'host', status: 'warning', message: `${TARGETS[target].note} Host trust, other configuration layers and live hook execution are not checked.` });
  return { target, configPath: path, ok: !checks.some((check) => check.status === 'error'), checks };
}
