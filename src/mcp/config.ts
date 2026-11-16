import { realpathSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateLauncher, type Launcher } from '../hooks/setup.ts';

export const MCP_TARGETS = ['claude-code', 'codex', 'generic'] as const;
export type McpTarget = typeof MCP_TARGETS[number];

/** Generate a standalone config; never merge or overwrite a user's host settings. */
export function mcpConfig(options: {
  target: string; cwd: string; launcher: Launcher; readOnly?: boolean; home?: string;
}): string {
  const { target, launcher } = options;
  if (!MCP_TARGETS.includes(target as McpTarget)) throw new Error(`unknown MCP target "${target}" (known: ${MCP_TARGETS.join(', ')})`);
  validateLauncher(launcher);
  const cwd = realpathSync(resolve(options.cwd));
  if (!statSync(cwd).isDirectory()) throw new Error('--cwd must name an existing project directory');
  const args = [launcher.cli, 'mcp', '--cwd', cwd, '--runtime', target === 'generic' ? 'mcp' : target];
  if (options.readOnly) args.push('--read-only');
  const env = options.home ? { HIVEMEM_HOME: resolve(options.home) } : undefined;
  if (target === 'codex') {
    // JSON string escaping is compatible with TOML basic strings for these paths.
    // Escape DEL as well: TOML forbids it even though JSON allows it literally.
    const quote = (value: string) => JSON.stringify(value).replaceAll('\x7f', '\\u007f');
    return ['[mcp_servers.hivemem]', `command = ${quote(launcher.node)}`,
      `args = [${args.map(quote).join(', ')}]`,
      ...(env ? ['', '[mcp_servers.hivemem.env]', `HIVEMEM_HOME = ${quote(env.HIVEMEM_HOME)}`] : []), ''].join('\n');
  }
  return JSON.stringify({ mcpServers: { hivemem: { command: launcher.node, args, ...(env ? { env } : {}) } } }, null, 2) + '\n';
}

export function writeMcpConfig(path: string, config: string): string {
  const destination = resolve(path);
  // wx also refuses symlinks. No mkdir or memory-store initialization on preview.
  writeFileSync(destination, config, { flag: 'wx', mode: 0o600 });
  return destination;
}
