import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { foldMemory } from '../src/ledger/fold.ts';
import { Hlc } from '../src/ledger/hlc.ts';
import { ulid } from '../src/ledger/ids.ts';
import { sealOp, verifyOp } from '../src/ledger/op.ts';
import type { Actor, MemoryState, Op, OpDraft, Status } from '../src/ledger/types.ts';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], r: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** A simulated replica: its own skewed clock and the ops it has seen so far. */
class Replica {
  readonly ops = new Map<string, Op>();
  readonly clock: Hlc;
  readonly actor: Actor;
  private readonly r: () => number;

  constructor(name: string, runtime: string, skewMs: number, r: () => number) {
    let t = 1_761_700_000_000 + skewMs;
    this.r = r;
    this.clock = new Hlc(name, () => (t += Math.floor(r() * 3)));
    this.actor = { tenant: 'local', principal: 'user:alice', runtime, agent: `${runtime}/main`, node: name };
  }

  emit(draft: Omit<OpDraft, 'actor' | 'scope'>): Op {
    const op = sealOp({ ...draft, actor: this.actor, scope: '/t/local/p/demo' } as OpDraft, this.clock);
    this.ops.set(op.op_id, op);
    return op;
  }

  receive(op: Op): void {
    if (this.ops.has(op.op_id)) return;
    this.clock.observe(op.hlc);
    this.ops.set(op.op_id, op);
  }

  view(id: string): MemoryState | null {
    return foldMemory([...this.ops.values()].filter((o) => o.target === id));
  }

  ids(): string[] {
    return [...new Set([...this.ops.values()].map((o) => o.target))].sort();
  }

  randomOps(n: number): Op[] {
    return shuffle([...this.ops.values()], this.r).slice(0, n);
  }
}

const STATUSES: Status[] = ['committed', 'quarantined', 'revoked', 'superseded', 'archived', 'tentative', 'conflicted'];

function simulate(seed: number, steps: number): Replica[] {
  const r = rng(seed);
  const nodes = [
    new Replica('n_a', 'claude-code', 0, r),
    new Replica('n_b', 'codex', 40, r),
    new Replica('n_c', 'codebuddy', -25, r),
  ];
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;

  for (let i = 0; i < steps; i++) {
    const node = pick(nodes);
    const ids = node.ids();
    const roll = r();
    if (roll < 0.15 || ids.length === 0) {
      node.emit({ type: 'mem.create', target: ulid(), payload: { kind: 'fact', content: `fact ${i}`, method: 'agent-stated', tags: ['t0'] } });
      continue;
    }
    const id = pick(ids);
    const view = node.view(id);
    if (roll < 0.4 && view) {
      node.emit({ type: 'mem.revise', target: id, payload: { content: `rev ${i} by ${node.clock.node}`, parents: [pick(view.heads)] } });
    } else if (roll < 0.5 && view && view.heads.length > 1) {
      node.emit({ type: 'conflict.resolve', target: id, payload: { parents: view.heads, choose: pick(view.heads) } });
    } else if (roll < 0.62) {
      node.emit({ type: 'mem.transition', target: id, payload: { to: pick(STATUSES) } });
    } else if (roll < 0.75) {
      node.emit({
        type: 'mem.meta',
        target: id,
        payload: r() < 0.5 ? { tags_add: [`t${i % 4}`], importance: 1 + Math.floor(r() * 5) } : { tags_remove: [`t${i % 4}`], corroborate: { runtime: node.actor.runtime } },
      });
    } else {
      const to = pick(nodes.filter((n) => n !== node));
      for (const op of node.randomOps(1 + Math.floor(r() * 6))) to.receive(op);
    }
  }
  return nodes;
}

function fullSync(nodes: Replica[], r: () => number): void {
  const all = nodes.flatMap((n) => [...n.ops.values()]);
  for (const n of nodes) for (const op of shuffle(all, r)) n.receive(op);
}

describe('ledger convergence (invariant I4)', () => {
  for (const seed of [1, 7, 42, 1234, 99991]) {
    it(`replicas converge after arbitrary partial syncs (seed ${seed})`, () => {
      const nodes = simulate(seed, 400);
      const r = rng(seed + 1);
      fullSync(nodes, r);
      const [first, ...rest] = nodes;
      const ids = first!.ids();
      assert.ok(ids.length > 5, 'scenario should create several memories');
      const views = ids.map((id) => first!.view(id)!);
      assert.ok(views.some((v) => v.versions.length > 2), 'scenario should revise memories');
      assert.ok(
        views.some((v) => v.versions.some((x) => x.parents.length > 1) || v.heads.length > 1),
        'scenario should produce concurrent revisions or resolves',
      );
      for (const id of ids) {
        const expected = JSON.stringify(first!.view(id));
        for (const n of rest) assert.equal(JSON.stringify(n.view(id)), expected, `memory ${id} diverged on ${n.clock.node}`);
        // A fresh replica folding the ops in a random order must agree too.
        const shuffled = shuffle([...first!.ops.values()].filter((o) => o.target === id), r);
        assert.equal(JSON.stringify(foldMemory(shuffled)), expected);
      }
    });
  }
});

describe('concurrent revisions (invariant I5)', () => {
  it('keeps both writes as sibling versions instead of last-writer-wins', () => {
    const r = rng(5);
    const a = new Replica('n_a', 'claude-code', 0, r);
    const b = new Replica('n_b', 'codex', 0, r);
    const create = a.emit({ type: 'mem.create', target: ulid(), payload: { kind: 'fact', content: 'tests use jest', method: 'agent-stated' } });
    b.receive(create);
    a.emit({ type: 'mem.transition', target: create.target, payload: { to: 'committed' } });
    a.emit({ type: 'mem.revise', target: create.target, payload: { content: 'tests use vitest', parents: [create.op_id] } });
    b.emit({ type: 'mem.revise', target: create.target, payload: { content: 'tests use node:test', parents: [create.op_id] } });
    fullSync([a, b], r);

    const view = a.view(create.target)!;
    assert.equal(view.status, 'conflicted');
    assert.equal(view.heads.length, 2);
    const contents = view.versions.filter((v) => view.heads.includes(v.op_id)).map((v) => v.content).sort();
    assert.deepEqual(contents, ['tests use node:test', 'tests use vitest']);

    a.emit({ type: 'conflict.resolve', target: create.target, payload: { parents: view.heads, content: 'tests use vitest (node:test for scripts)' } });
    const resolved = a.view(create.target)!;
    assert.equal(resolved.status, 'committed');
    assert.equal(resolved.content, 'tests use vitest (node:test for scripts)');
    assert.equal(resolved.versions.length, 4, 'history keeps every version');
  });

  it('a resolve that missed a concurrent revision leaves the memory conflicted', () => {
    const r = rng(6);
    const a = new Replica('n_a', 'claude-code', 0, r);
    const b = new Replica('n_b', 'codex', 0, r);
    const c = new Replica('n_c', 'codebuddy', 0, r);
    const create = a.emit({ type: 'mem.create', target: ulid(), payload: { kind: 'fact', content: 'v0', method: 'agent-stated' } });
    b.receive(create);
    c.receive(create);
    const ra = a.emit({ type: 'mem.revise', target: create.target, payload: { content: 'a', parents: [create.op_id] } });
    const rb = b.emit({ type: 'mem.revise', target: create.target, payload: { content: 'b', parents: [create.op_id] } });
    c.emit({ type: 'mem.revise', target: create.target, payload: { content: 'c', parents: [create.op_id] } });
    a.receive(rb);
    a.emit({ type: 'conflict.resolve', target: create.target, payload: { parents: [ra.op_id, rb.op_id], choose: ra.op_id } });
    fullSync([a, b, c], r);
    const view = c.view(create.target)!;
    assert.equal(view.status, 'conflicted');
    assert.equal(view.heads.length, 2);
  });
});

describe('state machine and ops', () => {
  it('ignores illegal transitions and records a warning', () => {
    const r = rng(9);
    const a = new Replica('n_a', 'claude-code', 0, r);
    const create = a.emit({ type: 'mem.create', target: ulid(), payload: { kind: 'decision', content: 'use postgres', method: 'user-stated' } });
    a.emit({ type: 'mem.transition', target: create.target, payload: { to: 'revoked' } });
    a.emit({ type: 'mem.transition', target: create.target, payload: { to: 'committed' } });
    const view = a.view(create.target)!;
    assert.equal(view.status, 'revoked');
    assert.equal(view.warnings.length, 1);
  });

  it('detects tampering through the op hash', () => {
    const r = rng(10);
    const a = new Replica('n_a', 'claude-code', 0, r);
    const op = a.emit({ type: 'mem.create', target: ulid(), payload: { kind: 'fact', content: 'x', method: 'agent-stated' } });
    assert.ok(verifyOp(op));
    const forged = { ...op, payload: { ...op.payload, content: 'y' } } as Op;
    assert.ok(!verifyOp(forged));
  });

  it('HLC strings sort in causal order across skewed clocks', () => {
    const fast = new Hlc('n_fast', () => 2_000);
    const slow = new Hlc('n_slow', () => 1_000);
    const t1 = fast.now();
    slow.observe(t1);
    const t2 = slow.now();
    assert.ok(t2 > t1, `${t2} should sort after ${t1}`);
  });
});
