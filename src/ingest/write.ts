import { ulid } from '../ledger/ids.ts';
import { sealOp } from '../ledger/op.ts';
import type { ClaimKey, Evidence, Kind, MemoryState, Method, Op, OpDraft, Status } from '../ledger/types.ts';
import type { Ctx, ScopeLevel } from '../identity/context.ts';
import { redact } from './redact.ts';

type Draft = Omit<OpDraft, 'actor' | 'scope'> & { scope?: string };

/** Seal drafts with this context's identity and clock, append them atomically, and persist the clock. */
export function commitOps(ctx: Ctx, drafts: Draft[], defaultScope: string): Op[] {
  const ops = drafts.map((d) => sealOp({ ...d, actor: ctx.actor, scope: d.scope ?? defaultScope } as OpDraft, ctx.clock));
  ctx.store.appendOps(ops);
  const last = ops.at(-1);
  if (last) ctx.store.setMeta('last_hlc', last.hlc);
  return ops;
}

export interface RememberInput {
  content: string;
  kind?: Kind;
  key?: ClaimKey;
  level?: ScopeLevel;
  method?: Method;
  tags?: string[];
  importance?: number;
  evidence?: Evidence[];
  untrusted?: boolean;
}

export interface RememberResult {
  id: string;
  status: Status;
  action: 'created' | 'reinforced' | 'corroborated';
  superseded: string[];
  contradicts: string[];
  redacted: string[];
}

const ACTIVE: Status[] = ['committed', 'tentative', 'quarantined', 'conflicted'];

export function normalizeContent(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
}

const authority = (m: Method): number => ({ 'user-stated': 3, 'agent-stated': 2, imported: 2, 'hook-capture': 1, 'dream-derived': 0 })[m];

function distinctRuntimes(m: MemoryState): number {
  return new Set([m.author.runtime, ...m.corroborations.map((c) => c.runtime)]).size;
}

/**
 * Write path for one statement (ARCHITECTURE §6): redact, dedup, key-conflict handling, validation.
 * User statements commit immediately; agent statements stay tentative until another runtime corroborates them.
 */
export function remember(ctx: Ctx, input: RememberInput): RememberResult {
  const { text, hits } = redact(input.content.trim());
  if (!text) throw new Error('empty memory');
  const method = input.method ?? 'agent-stated';
  const kind = input.kind ?? 'fact';
  const scope = ctx.scopeFor(input.level ?? 'project');
  const norm = normalizeContent(text);
  const drafts: Draft[] = [];

  // 1. Exact duplicate in the same scope: reinforce or corroborate instead of creating.
  const dup = ctx.store
    .search(text, { scopes: [scope], statuses: ACTIVE, limit: 20 })
    .map((h) => ctx.store.get(h.id))
    .find((m) => m && normalizeContent(m.content) === norm);
  if (dup) {
    const sameSource = dup.author.runtime === ctx.actor.runtime || dup.corroborations.some((c) => c.runtime === ctx.actor.runtime);
    if (!sameSource) drafts.push({ type: 'mem.meta', target: dup.id, payload: { corroborate: { runtime: ctx.actor.runtime, session: ctx.actor.session } } });
    const runtimes = distinctRuntimes(dup) + (sameSource ? 0 : 1);
    const promote = dup.status === 'tentative' && (method === 'user-stated' || runtimes >= 2);
    if (promote) drafts.push({ type: 'mem.transition', target: dup.id, payload: { to: 'committed' }, reason: method === 'user-stated' ? 'user confirmed' : 'corroborated by another runtime' });
    if (drafts.length) commitOps(ctx, drafts, scope);
    return {
      id: dup.id,
      status: promote ? 'committed' : dup.status,
      action: sameSource ? 'reinforced' : 'corroborated',
      superseded: [],
      contradicts: [],
      redacted: hits,
    };
  }

  // 2. Create, then resolve claim-key conflicts by authority.
  const id = ulid();
  drafts.push({
    type: 'mem.create',
    target: id,
    payload: { kind, content: text, method, key: input.key, tags: input.tags, importance: input.importance, evidence: input.evidence, untrusted: input.untrusted },
  });
  let status: Status = method === 'user-stated' && !input.untrusted ? 'committed' : 'tentative';
  const superseded: string[] = [];
  const contradicts: string[] = [];

  if (input.key) {
    const rivals = ctx.store.byKey(input.key.subject, input.key.aspect, { scopes: [scope], statuses: ACTIVE }).filter((m) => normalizeContent(m.content) !== norm);
    for (const old of rivals) {
      const mine = authority(method);
      const theirs = authority(old.method);
      if (mine > theirs || (mine === 3 && theirs === 3)) {
        // Higher authority, or the user changing their mind: the new statement wins, history is kept.
        drafts.push({ type: 'mem.transition', target: old.id, payload: { to: 'superseded', by: id }, reason: `superseded by ${id}` });
        drafts.push({ type: 'edge.add', target: id, payload: { dst: old.id, type: 'supersedes' } });
        superseded.push(old.id);
      } else if (mine < theirs) {
        drafts.push({ type: 'edge.add', target: id, payload: { dst: old.id, type: 'contradicts' } });
        contradicts.push(old.id);
      } else {
        // Same authority and no way to tell who is right: quarantine both for review.
        drafts.push({ type: 'edge.add', target: id, payload: { dst: old.id, type: 'contradicts' } });
        if (old.status !== 'quarantined') drafts.push({ type: 'mem.transition', target: old.id, payload: { to: 'quarantined' }, reason: `conflicts with ${id}` });
        status = 'quarantined';
        contradicts.push(old.id);
      }
    }
  }
  if (status !== 'tentative') drafts.push({ type: 'mem.transition', target: id, payload: { to: status }, reason: status === 'committed' ? 'user-stated' : 'same-authority conflict' });
  commitOps(ctx, drafts, scope);
  return { id, status, action: 'created', superseded, contradicts, redacted: hits };
}

export function transition(ctx: Ctx, id: string, to: Status, reason?: string): MemoryState {
  const m = mustGet(ctx, id);
  commitOps(ctx, [{ type: 'mem.transition', target: id, payload: { to }, reason, scope: m.scope }], m.scope);
  return mustGet(ctx, id);
}

export function revise(ctx: Ctx, id: string, content: string): MemoryState {
  const m = mustGet(ctx, id);
  const { text } = redact(content.trim());
  commitOps(ctx, [{ type: 'mem.revise', target: id, payload: { content: text, parents: m.heads }, scope: m.scope }], m.scope);
  return mustGet(ctx, id);
}

export function resolveConflict(ctx: Ctx, id: string, choice: { choose?: string; content?: string }): MemoryState {
  const m = mustGet(ctx, id);
  if (m.heads.length < 2) throw new Error(`memory ${id} has no conflict to resolve`);
  const drafts: Draft[] = [{ type: 'conflict.resolve', target: id, payload: { parents: m.heads, ...choice }, scope: m.scope }];
  commitOps(ctx, drafts, m.scope);
  return mustGet(ctx, id);
}

export function setMeta(ctx: Ctx, id: string, payload: { pinned?: boolean; importance?: number; tags_add?: string[]; tags_remove?: string[] }): MemoryState {
  const m = mustGet(ctx, id);
  commitOps(ctx, [{ type: 'mem.meta', target: id, payload, scope: m.scope }], m.scope);
  return mustGet(ctx, id);
}

function mustGet(ctx: Ctx, id: string): MemoryState {
  const m = ctx.store.get(id);
  if (!m) throw new Error(`no memory ${id}`);
  return m;
}
