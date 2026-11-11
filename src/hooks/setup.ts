import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Only events with implemented, session-level behaviour are installed. */
export const EVENTS = ['SessionStart', 'UserPromptSubmit'] as const;
export interface HookCommand {
  type: 'command';
  command: string;
  args?: string[];
  commandWindows?: string;
  timeout: number;
}
export type HookConfig = { hooks: Record<string, { hooks: HookCommand[] }[]> };
export interface Launcher { node: string; cli: string }

export const TARGETS = {
  'claude-code': { directory: '.claude', filename: 'settings.json', note: 'Review /hooks and restart the session.' },
  codebuddy: { directory: '.codebuddy', filename: 'settings.json', note: 'Review /hooks and restart the session. Windows requires Git Bash.' },
  codex: { directory: '.codex', filename: 'hooks.json', note: 'Review and trust the commands in /hooks, then restart the session.' },
} as const;
export type Target = keyof typeof TARGETS;

export function targetName(value: string): Target {
  if (!Object.hasOwn(TARGETS, value)) throw new Error(`unknown target "${value}" (known: ${Object.keys(TARGETS).join(', ')})`);
  return value as Target;
}

export function configPath(target: Target, override?: string): string {
  if (override) return resolve(override);
  const directory = target === 'codex' && process.env.CODEX_HOME
    ? resolve(process.env.CODEX_HOME) : join(homedir(), TARGETS[target].directory);
  return join(directory, TARGETS[target].filename);
}

export function validateLauncher(launcher: Launcher): void {
  if (!launcher || typeof launcher.node !== 'string' || typeof launcher.cli !== 'string'
    || !isAbsolute(launcher.node) || !isAbsolute(launcher.cli)
    || /[\0\r\n]/.test(launcher.node + launcher.cli)) {
    throw new Error('hook launcher must contain absolute Node and CLI paths');
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/** Codex uses COMSPEC /C on Windows; CodeBuddy uses Git Bash. Claude supports direct exec. */
export function hookConfig(target: Target, launcher: Launcher, platform = process.platform): HookConfig {
  validateLauncher(launcher);
  return { hooks: Object.fromEntries(EVENTS.map((event) => {
    const args = [launcher.cli, 'hook', event, '--runtime', target];
    let command: HookCommand;
    if (target === 'claude-code') {
      command = { type: 'command', command: launcher.node, args, timeout: 10 };
    } else {
      const words = [launcher.node, ...args];
      command = { type: 'command', command: words.map((word) => shellQuote(platform === 'win32' ? word.replaceAll('\\', '/') : word)).join(' '), timeout: 10 };
      if (target === 'codex' && platform === 'win32') {
        // Refuse paths that cmd.exe expands even inside quotes. Never interpolate them unescaped.
        if (words.some((word) => /[%!"\r\n]/.test(word))) {
          throw new Error('Codex on Windows needs installation paths without %, ! or double quotes; move the checkout or Node installation');
        }
        command.commandWindows = words.map((word) => `"${word}"`).join(' ');
      }
    }
    return [event, [{ hooks: [command] }]];
  })) };
}

export function setupText(targets: string[], launcher: Launcher, bin?: string): string {
  return targets.map((name) => {
    const target = targetName(name);
    const config = bin ? { hooks: Object.fromEntries(EVENTS.map((event) => [event, [{ hooks: [
      { type: 'command', command: `${bin} hook ${event} --runtime ${target}`, timeout: 10 },
    ] }]])) } : hookConfig(target, launcher);
    return [`# ${target} -> ${configPath(target)}`, `# ${TARGETS[target].note}`, JSON.stringify(config, null, 2)].join('\n');
  }).join('\n\n');
}
