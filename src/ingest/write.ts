import { ulid } from '../ledger/ids.ts';
import { sealOp } from '../ledger/op.ts';
import { ACTIVE, authority, memoryAuthority, normalizeContent } from '../ledger/claims.ts';
import { TRANSITIONS } from '../ledger/fold.ts';
import type { ClaimKey, Evidence, Kind, MemoryState, Method, Op, OpDraft, Status } from '../ledger/types.ts';
import type { Ctx, ScopeLevel } from '../identity/context.ts';
import { redact } from './redact.ts';

export { normalizeContent } from '../ledger/claims.ts';

type Draft = Omit<OpDraft, 'actor' | 'scope'> & { scope?: string };

/** Seal drafts with this context's identity and clock, append them atomically, and persist the clock. */
export function commitOps(ctx: Ctx, drafts: Draft[], defaultScope: string): Op[] {
  const ops = drafts.map((d) => sealOp({ ...d, actor: ctx.actor, scope: d.scope ?? defaultScope } as OpDraft, ctx.clock));
  ctx.store.appendOps(ops);
  return ops;
}

function write<T>(ctx: Ctx, fn: () => T): T {
  return ctx.store.transaction(() => {
    const last = ctx.store.getMeta('last_hlc');
    if (last) ctx.clock.observe(last);
    return fn();
  });
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

function distinctRuntimes(m: MemoryState): number {
  return new Set([m.author.runtime, ...m.corroborations.map((c) => c.runtime)]).size;
}

/**
 * Write path for one statement (ARCHITECTURE §6): redact, dedup, key-conflict handling, validation.
 * User statements commit immediately; agent statements stay tentative until another runtime corroborates them.
 */
export function remember(ctx: Ctx, input: RememberInput): RememberResult {
  return write(ctx, () => rememberLocked(ctx, input));
}

function rememberLocked(ctx: Ctx, input: RememberInput): RememberResult {
  const { text, hits } = redact(input.content.trim());
  if (!text) throw new Error('empty memory');
  const method = input.method ?? 'agent-stated';
  const kind = input.kind ?? 'fact';
  const scope = ctx.scopeFor(input.level ?? 'project');
  const norm = normalizeContent(text);
  const drafts: Draft[] = [];
  if (input.key && (!input.key.subject.trim() || !input.key.aspect.trim())) throw new Error('claim key requires a subject and aspect');
  if (input.importance !== undefined && (!Number.isInteger(input.importance) || input.importance < 1 || input.importance > 5)) throw new Error('importance must be an integer from 1 to 5');

  // 1. Exact duplicate in the same scope: reinforce or corroborate instead of creating.
  const dup = ctx.store.exact(text, scope, kind, input.key).find((m) => ACTIVE.includes(m.status));
  if (dup) {
    if (method === 'user-stated' && !input.untrusted) {
      const superseded = confirm(ctx, dup);
      return { id: dup.id, status: mustGet(ctx, dup.id).status, action: 'reinforced', superseded, contradicts: [], redacted: hits };
    }
    const sameSource = dup.author.runtime === ctx.actor.runtime || dup.corroborations.some((c) => c.runtime === ctx.actor.runtime);
    if (!sameSource && !input.untrusted && !dup.untrusted) drafts.push({ type: 'mem.meta', target: dup.id, payload: { corroborate: { runtime: ctx.actor.runtime, session: ctx.actor.session, version: dup.head } } });
    const runtimes = distinctRuntimes(dup) + (sameSource ? 0 : 1);
    const promote = dup.status === 'tentative' && !input.untrusted && !dup.untrusted && !dup.claim_conflicts.length && runtimes >= 2;
    if (promote) drafts.push({ type: 'mem.transition', target: dup.id, payload: { to: 'committed', version: dup.head }, reason: 'corroborated by another runtime' });
    if (drafts.length) commitOps(ctx, drafts, scope);
    return {
      id: dup.id,
      status: mustGet(ctx, dup.id).status,
      action: sameSource ? 'reinforced' : 'corroborated',
      superseded: [],
      contradicts: dup.claim_conflicts,
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
      const mine = authority(method, input.untrusted);
      const theirs = memoryAuthority(old);
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
  return { id, status: mustGet(ctx, id).status, action: 'created', superseded, contradicts, redacted: hits };
}

/** Explicit human review settles the claim and preserves every rejected alternative in history. */
function confirm(ctx: Ctx, m: MemoryState): string[] {
  if (m.heads.length > 1) throw new Error('resolve sibling versions before confirming this memory');
  if (m.status === 'revoked') throw new Error('a revoked memory cannot be confirmed');
  const rivals = m.key ? ctx.store.byKey(m.key.subject, m.key.aspect, { scopes: [m.scope], statuses: ACTIVE })
    .filter((old) => old.id !== m.id && normalizeContent(old.content) !== normalizeContent(m.content)) : [];
  const drafts: Draft[] = [{ type: 'mem.transition', target: m.id, scope: m.scope,
    payload: { to: 'committed', version: m.head, confirmed: true }, reason: 'explicit user confirmation' }];
  for (const old of rivals) {
    drafts.push({ type: 'mem.transition', target: old.id, scope: old.scope, payload: { to: 'superseded', by: m.id }, reason: `user confirmed ${m.id}` });
    drafts.push({ type: 'edge.add', target: m.id, payload: { dst: old.id, type: 'supersedes' } });
  }
  commitOps(ctx, drafts, m.scope);
  return rivals.map((old) => old.id);
}

export function transition(ctx: Ctx, id: string, to: Status, reason?: string): MemoryState {
  return write(ctx, () => {
    const m = mustGet(ctx, id);
    if (to === 'committed') confirm(ctx, m);
    else {
      if (m.base_status === to) return m;
      if (!(m.base_status === 'conflicted' && to === 'revoked') && !TRANSITIONS[m.base_status].includes(to)) throw new Error(`illegal transition ${m.status} -> ${to}`);
      commitOps(ctx, [{ type: 'mem.transition', target: id, payload: { to }, reason, scope: m.scope }], m.scope);
    }
    return mustGet(ctx, id);
  });
}

export function revise(ctx: Ctx, id: string, content: string): MemoryState {
  return write(ctx, () => {
    const m = mustGet(ctx, id);
    if (m.heads.length > 1) throw new Error('use resolve to choose or merge sibling versions');
    if (['revoked', 'superseded', 'archived'].includes(m.status)) throw new Error(`cannot revise a ${m.status} memory`);
    const { text } = redact(content.trim());
    if (!text) throw new Error('empty memory');
    commitOps(ctx, [{ type: 'mem.revise', target: id, payload: { content: text, parents: m.heads }, scope: m.scope }], m.scope);
    return mustGet(ctx, id);
  });
}

export function resolveConflict(ctx: Ctx, id: string, choice: { choose?: string; content?: string }): MemoryState {
  return write(ctx, () => {
    const m = mustGet(ctx, id);
    if (['revoked', 'superseded', 'archived'].includes(m.status)) throw new Error(`cannot resolve a ${m.status} memory`);
    if (m.heads.length < 2) throw new Error(`memory ${id} has no conflict to resolve`);
    if ((choice.choose !== undefined) === (choice.content !== undefined)) throw new Error('provide exactly one of --choose or --content');
    if (choice.choose !== undefined && !m.heads.includes(choice.choose)) throw new Error('--choose must name a current sibling version');
    if (choice.content !== undefined) {
      choice = { content: redact(choice.content.trim()).text };
      if (!choice.content) throw new Error('empty memory');
    }
    const drafts: Draft[] = [{ type: 'conflict.resolve', target: id, payload: { parents: m.heads, ...choice }, scope: m.scope }];
    commitOps(ctx, drafts, m.scope);
    return mustGet(ctx, id);
  });
}

export function setMeta(ctx: Ctx, id: string, payload: { pinned?: boolean; importance?: number; tags_add?: string[]; tags_remove?: string[] }): MemoryState {
  return write(ctx, () => {
    const m = mustGet(ctx, id);
    commitOps(ctx, [{ type: 'mem.meta', target: id, payload, scope: m.scope }], m.scope);
    return mustGet(ctx, id);
  });
}

function mustGet(ctx: Ctx, id: string): MemoryState {
  const m = ctx.store.get(id);
  if (!m) throw new Error(`no memory ${id}`);
  return m;
}
