import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { sha256 } from '../ledger/ids.ts';

export interface ProjectIdentity {
  id: string;
  display: string;
  root: string;
  source: 'remote' | 'root-commit' | 'path';
  remote_norm?: string;
  root_commit?: string;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalise a git remote so every clone, fork-of-same-URL and protocol variant maps to one key.
 *   git@github.com:Acme/API.git  ->  github.com/acme/api
 *   https://user@github.com/acme/api  ->  github.com/acme/api
 */
export function normalizeRemote(url: string): string {
  let u = url.trim();
  const scp = /^([^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(u);
  if (scp && !/^[a-z]+:\/\//i.test(u)) u = `ssh://${scp[2]}/${scp[3]}`;
  u = u.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '');
  u = u.replace(/:\d+(?=\/)/, '');
  u = u.replace(/\.git\/?$/i, '').replace(/\/+$/, '');
  return u.toLowerCase();
}

function projectId(seed: string): string {
  return `p_${sha256(seed).slice(0, 12)}`;
}

interface GitLocation {
  top: string;
  commonDir: string;
}

/** Find the repository by walking up for `.git`; follows worktree `gitdir:` files to the shared git dir. */
export function findGit(start: string): GitLocation | undefined {
  let dir = resolve(start);
  for (;;) {
    const dotGit = join(dir, '.git');
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return { top: dir, commonDir: dotGit };
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
      if (m) {
        const gitDir = resolve(dir, m[1]!.trim());
        const common = join(gitDir, 'commondir');
        return { top: dir, commonDir: existsSync(common) ? resolve(gitDir, readFileSync(common, 'utf8').trim()) : gitDir };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Read `[remote "origin"] url` straight from the git config file (no subprocess: spawning git costs ~50ms on Windows). */
export function readOriginUrl(commonDir: string): string | undefined {
  const file = join(commonDir, 'config');
  if (!existsSync(file)) return undefined;
  let inOrigin = false;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const section = /^\s*\[(.+)\]\s*$/.exec(line);
    if (section) {
      inOrigin = /^remote\s+"origin"$/.test(section[1]!.trim());
      continue;
    }
    const kv = inOrigin && /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (kv) return kv[1];
  }
  return undefined;
}

/**
 * Stable project identity (ARCHITECTURE §3.2): normalised origin remote, else the repository's
 * root commit (identical across clones and worktrees), else the absolute path.
 */
export function resolveProject(cwd: string): ProjectIdentity {
  const loc = findGit(cwd);
  if (loc) {
    const root = loc.top;
    const remote = readOriginUrl(loc.commonDir);
    if (remote) {
      const norm = normalizeRemote(remote);
      return { id: projectId(`remote:${norm}`), display: norm, root, source: 'remote', remote_norm: norm };
    }
    const rootCommit = git(cwd, ['rev-list', '--max-parents=0', 'HEAD'])?.split('\n')[0];
    if (rootCommit) return { id: projectId(`commit:${rootCommit}`), display: basename(root), root, source: 'root-commit', root_commit: rootCommit };
    return { id: projectId(`path:${root.toLowerCase()}`), display: basename(root), root, source: 'path' };
  }
  const root = resolve(cwd);
  return { id: projectId(`path:${root.toLowerCase()}`), display: basename(root), root, source: 'path' };
}
