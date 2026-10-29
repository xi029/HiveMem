import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Hlc } from '../ledger/hlc.ts';
import { ulid } from '../ledger/ids.ts';
import type { Actor } from '../ledger/types.ts';
import { SqliteStore } from '../store/sqlite.ts';
import { type ProjectIdentity, resolveProject } from './project.ts';

export const TENANT = 'local';

export function hivememHome(): string {
  return process.env.HIVEMEM_HOME ?? join(homedir(), '.hivemem');
}

/** This machine's node id, created once and kept in ~/.hivemem/node.json. */
export function nodeId(home = hivememHome()): string {
  const file = join(home, 'node.json');
  if (existsSync(file)) return (JSON.parse(readFileSync(file, 'utf8')) as { node: string }).node;
  mkdirSync(home, { recursive: true });
  const node = `n_${ulid()}`;
  writeFileSync(file, JSON.stringify({ node }, null, 2));
  return node;
}

export function principal(): string {
  return process.env.HIVEMEM_PRINCIPAL ?? `user:${userInfo().username.toLowerCase()}`;
}

/** Scope paths (ARCHITECTURE §3.3). */
export const scopes = {
  user: (p: string) => `/t/${TENANT}/u/${p.replace(/^user:/, '')}`,
  userInProject: (p: string, project: string) => `/t/${TENANT}/u/${p.replace(/^user:/, '')}/p/${project}`,
  project: (project: string) => `/t/${TENANT}/p/${project}`,
  agent: (project: string, agent: string) => `/t/${TENANT}/p/${project}/a/${agent}`,
  session: (session: string) => `/t/${TENANT}/s/${session}`,
};

export type ScopeLevel = 'session' | 'agent' | 'user-project' | 'project' | 'user';

export interface Ctx {
  store: SqliteStore;
  clock: Hlc;
  actor: Actor;
  project: ProjectIdentity;
  /** Visible scopes from most to least specific, used for recall proximity. */
  chain: { level: ScopeLevel; scope: string }[];
  scopeFor(level: ScopeLevel): string;
}

export interface CtxOptions {
  cwd?: string;
  runtime?: string;
  agent?: string;
  session?: string;
  model?: string;
  dbPath?: string;
}

export function openContext(o: CtxOptions = {}): Ctx {
  const home = hivememHome();
  const store = new SqliteStore(o.dbPath ?? join(home, 'hivemem.db'));
  const node = nodeId(home);
  const clock = new Hlc(node);
  const last = store.getMeta('last_hlc');
  if (last) clock.observe(last);

  const runtime = o.runtime ?? process.env.HIVEMEM_RUNTIME ?? 'cli';
  const actor: Actor = {
    tenant: TENANT,
    principal: principal(),
    runtime,
    agent: o.agent ?? `${runtime}/main`,
    node,
    session: o.session,
    model: o.model,
  };
  const project = resolveProject(o.cwd ?? process.cwd());
  store.upsertProject({ id: project.id, display: project.display, remote_norm: project.remote_norm, root_commit: project.root_commit, path: project.root });

  const scopeFor = (level: ScopeLevel): string => {
    switch (level) {
      case 'session':
        return scopes.session(o.session ?? 'none');
      case 'agent':
        return scopes.agent(project.id, actor.agent);
      case 'user-project':
        return scopes.userInProject(actor.principal, project.id);
      case 'project':
        return scopes.project(project.id);
      case 'user':
        return scopes.user(actor.principal);
    }
  };
  const levels: ScopeLevel[] = o.session ? ['session', 'agent', 'user-project', 'project', 'user'] : ['agent', 'user-project', 'project', 'user'];
  return { store, clock, actor, project, chain: levels.map((level) => ({ level, scope: scopeFor(level) })), scopeFor };
}
