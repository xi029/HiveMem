import type { MemoryState, Op, Status, Version } from './types.ts';

/** Total order over ops: HLC first, op_id as a tiebreak. Every replica sorts identically (invariant I4). */
export function compareOps(a: Op, b: Op): number {
  if (a.hlc !== b.hlc) return a.hlc < b.hlc ? -1 : 1;
  return a.op_id < b.op_id ? -1 : a.op_id > b.op_id ? 1 : 0;
}

/** Legal explicit transitions. `conflicted` is derived from the version graph, never set directly. */
export const TRANSITIONS: Record<Status, readonly Status[]> = {
  tentative: ['committed', 'quarantined', 'revoked', 'superseded'],
  committed: ['superseded', 'archived', 'revoked', 'quarantined'],
  quarantined: ['committed', 'revoked', 'tentative', 'superseded'],
  conflicted: [],
  superseded: ['committed', 'revoked'],
  archived: ['committed', 'revoked'],
  revoked: [],
};

/**
 * Fold every op that targets one memory into its current state. Pure and order-independent:
 * the input is sorted here, and version parents are explicit in each op, so any replica holding
 * the same op set computes the same state.
 */
export function foldMemory(input: readonly Op[]): MemoryState | null {
  const ops = [...input].sort(compareOps);
  const create = ops.find((o) => o.type === 'mem.create');
  if (!create || create.type !== 'mem.create') return null;

  const p = create.payload;
  const versions = new Map<string, Version>();
  versions.set(create.op_id, {
    op_id: create.op_id,
    parents: [],
    content: p.content,
    key: p.key,
    hlc: create.hlc,
    actor: create.actor,
  });

  const tagState = new Map<string, boolean>();
  for (const t of p.tags ?? []) tagState.set(t, true);

  const state: MemoryState = {
    id: create.target,
    scope: create.scope,
    kind: p.kind,
    status: 'tentative',
    content: p.content,
    key: p.key,
    tags: [],
    importance: p.importance ?? 3,
    pinned: false,
    method: p.method,
    author: create.actor,
    evidence: p.evidence ?? [],
    untrusted: p.untrusted ?? false,
    corroborations: [],
    created_hlc: create.hlc,
    revised_hlc: create.hlc,
    head: create.op_id,
    heads: [create.op_id],
    versions: [],
    valid_from: p.valid_from,
    warnings: [],
  };
  let base: Status = 'tentative';

  const latestParent = (parents: string[]): Version | undefined =>
    parents
      .map((id) => versions.get(id))
      .filter((v): v is Version => v !== undefined)
      .sort((a, b) => (a.hlc < b.hlc ? -1 : 1))
      .at(-1);

  for (const op of ops) {
    if (op === create) continue;
    switch (op.type) {
      case 'mem.create':
        state.warnings.push(`duplicate create ${op.op_id} ignored`);
        break;
      case 'mem.revise': {
        const parent = latestParent(op.payload.parents);
        const key = op.payload.key === null ? undefined : (op.payload.key ?? parent?.key);
        versions.set(op.op_id, {
          op_id: op.op_id,
          parents: op.payload.parents,
          content: op.payload.content ?? parent?.content ?? '',
          key,
          hlc: op.hlc,
          actor: op.actor,
        });
        break;
      }
      case 'conflict.resolve': {
        const chosen = op.payload.choose ? versions.get(op.payload.choose) : undefined;
        const parent = latestParent(op.payload.parents);
        versions.set(op.op_id, {
          op_id: op.op_id,
          parents: op.payload.parents,
          content: op.payload.content ?? chosen?.content ?? parent?.content ?? '',
          key: chosen?.key ?? parent?.key,
          hlc: op.hlc,
          actor: op.actor,
        });
        break;
      }
      case 'mem.meta': {
        const m = op.payload;
        if (m.importance !== undefined) state.importance = Math.min(5, Math.max(1, m.importance));
        if (m.pinned !== undefined) state.pinned = m.pinned;
        for (const t of m.tags_add ?? []) tagState.set(t, true);
        for (const t of m.tags_remove ?? []) tagState.set(t, false);
        if (m.corroborate) {
          const c = m.corroborate;
          const seen = state.corroborations.some((x) => x.runtime === c.runtime && x.session === c.session);
          if (!seen) state.corroborations.push({ ...c });
        }
        break;
      }
      case 'mem.transition': {
        const to = op.payload.to;
        if (TRANSITIONS[base].includes(to)) {
          base = to;
          if (to === 'superseded') state.superseded_by = op.payload.by;
          else if (to === 'committed') state.superseded_by = undefined;
        } else {
          state.warnings.push(`illegal transition ${base} -> ${to} (${op.op_id}) ignored`);
        }
        break;
      }
      case 'edge.add':
      case 'edge.remove':
        break; // edges live in their own projection
    }
  }

  const referenced = new Set<string>();
  for (const v of versions.values()) for (const parent of v.parents) referenced.add(parent);
  const all = [...versions.values()].sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.op_id < b.op_id ? -1 : 1));
  const heads = all.filter((v) => !referenced.has(v.op_id));
  const head = heads.at(-1) ?? all.at(-1)!;

  state.versions = all;
  state.heads = heads.map((v) => v.op_id);
  state.head = head.op_id;
  state.content = head.content;
  state.key = head.key;
  state.revised_hlc = all.at(-1)!.hlc;
  state.tags = [...tagState.entries()].filter(([, on]) => on).map(([t]) => t).sort();
  state.status = base === 'revoked' ? 'revoked' : heads.length > 1 ? 'conflicted' : base;
  return state;
}
