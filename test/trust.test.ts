import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Hlc } from '../src/ledger/hlc.ts';
import { sealOp } from '../src/ledger/op.ts';
import { type Ctx } from '../src/identity/context.ts';
import { remember, resolveConflict, revise, transition } from '../src/ingest/write.ts';
import { recall } from '../src/recall/recall.ts';
import { SqliteStore } from '../src/store/sqlite.ts';
import { estimateTokens } from '../src/store/tokenize.ts';
import type { Op } from '../src/ledger/types.ts';

const stores: SqliteStore[] = [];
const scope = '/t/local/p/trust-test';
const key = { subject: 'project', aspect: 'pkg.manager' };

function context(runtime: string, store?: SqliteStore): Ctx {
  if (!store) { store = new SqliteStore(':memory:'); stores.push(store); }
  return {
    store, clock: new Hlc(runtime),
    actor: { tenant: 'local', principal: 'user:test', runtime, agent: `${runtime}/main`, node: runtime },
    project: { id: 'trust-test', display: 'trust-test', root: process.cwd(), source: 'path' },
    chain: [{ level: 'project', scope }], scopeFor: () => scope,
  };
}

afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function siblings(ctx: Ctx, id: string): Op[] {
  const parent = ctx.store.get(id)!.head;
  return ['tests use vitest', 'tests use node:test'].map((content) => sealOp({
    type: 'mem.revise', target: id, scope, actor: ctx.actor, payload: { parents: [parent], content },
  }, ctx.clock));
}

describe('trust and conflict admission', () => {
  it('does not let corroboration override a user statement', () => {
    const a = context('claude-code');
    const b = context('codex', a.store);
    const user = remember(a, { content: 'use pnpm', key, method: 'user-stated' });
    const agent = remember(a, { content: 'use npm', key });
    assert.equal(remember(b, { content: 'use npm', key }).status, 'tentative');
    assert.deepEqual(a.store.get(agent.id)!.claim_conflicts, [user.id]);
    assert.deepEqual(recall(a, { includeTentative: true }).items.map((x) => x.memory.id), [user.id]);
  });

  it('explicit confirmation settles quarantined claims and retains user authority', () => {
    const a = context('claude-code');
    const first = remember(a, { content: 'use npm', key });
    const other = remember(a, { content: 'use pnpm', key });
    assert.equal(other.status, 'quarantined');
    assert.equal(remember(a, { content: 'use npm', key, method: 'user-stated' }).id, first.id);
    assert.equal(a.store.get(other.id)!.status, 'superseded');
    assert.equal(a.store.get(first.id)!.status, 'committed');
    assert.ok(a.store.get(first.id)!.confirmed_by);
    const late = remember(context('codex', a.store), { content: 'use bun', key });
    assert.equal(late.status, 'tentative');
    assert.equal(a.store.get(first.id)!.status, 'committed');
  });

  it('untrusted repeats cannot confirm, corroborate or supersede trusted memories', () => {
    const a = context('claude-code');
    const b = context('codex', a.store);
    const existing = remember(a, { content: 'use pnpm', key, method: 'user-stated' });
    const bad = remember(b, { content: 'use npm', key, method: 'user-stated', untrusted: true });
    remember(a, { content: 'use npm', key });
    assert.equal(a.store.get(existing.id)!.status, 'committed');
    assert.equal(a.store.get(bad.id)!.status, 'tentative');
    assert.deepEqual(a.store.get(bad.id)!.corroborations, []);
    const independent = remember(a, { content: 'tests run daily' });
    remember(b, { content: 'tests run daily', untrusted: true });
    assert.equal(a.store.get(independent.id)!.status, 'tentative');
    assert.deepEqual(a.store.get(independent.id)!.corroborations, []);
    assert.equal(recall(b, { includeTentative: true }).items.some((i) => i.memory.id === bad.id), false);
  });

  it('deduplication preserves punctuation, case, claim key and kind without requiring FTS terms', () => {
    const a = context('claude-code');
    const b = context('codex', a.store);
    const ids = ['C', 'C++', 'C#', 'c', '!', '?', 'echo "a  b"', 'echo "a b"'].map((content) => remember(a, { content }).id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(remember(b, { content: '!' }).id, ids[4]);
    const one = remember(a, { content: 'npm', key });
    const two = remember(a, { content: 'npm', key: { ...key, aspect: 'test.command' } });
    const three = remember(a, { content: 'npm', key, kind: 'decision' });
    assert.equal(new Set([one.id, two.id, three.id]).size, 3);
  });

  it('new versions lose old confirmations and corroborations, and can be approved again', () => {
    const a = context('claude-code');
    const b = context('codex', a.store);
    const m = remember(a, { content: 'tests use jest' });
    remember(b, { content: 'tests use jest' });
    transition(a, m.id, 'committed');
    const oldHead = a.store.get(m.id)!.head;
    const revised = revise(b, m.id, 'tests use vitest');
    assert.equal(revised.status, 'tentative');
    assert.equal(revised.confirmed_by, undefined);
    assert.deepEqual(revised.corroborations, []);
    a.store.appendOps([sealOp({ type: 'mem.transition', target: m.id, scope, actor: a.actor,
      payload: { to: 'committed', version: oldHead, confirmed: true } }, b.clock)]);
    assert.equal(a.store.get(m.id)!.status, 'tentative', 'stale approvals do not apply to new content');
    assert.equal(remember(a, { content: 'tests use vitest' }).status, 'committed');
  });
});

describe('claim convergence across independently created records', () => {
  it('quarantines conflicting creates in any arrival order, then resolves through confirmation', () => {
    const a = context('left');
    const b = context('right');
    const one = remember(a, { content: 'use npm', key, method: 'user-stated' });
    const two = remember(b, { content: 'use pnpm', key, method: 'user-stated' });
    const ops = [...a.store.recentOps(100), ...b.store.recentOps(100)];
    a.store.appendOps(ops);
    for (const op of [...ops].reverse()) b.store.appendOps([op]);
    for (const id of [one.id, two.id]) {
      assert.equal(a.store.get(id)!.status, 'quarantined');
      assert.deepEqual(a.store.get(id), b.store.get(id));
    }
    assert.equal(recall(a).items.length, 0);
    transition(a, one.id, 'committed');
    b.store.appendOps(a.store.recentOps(100).reverse());
    assert.equal(b.store.get(one.id)!.status, 'committed');
    assert.equal(b.store.get(two.id)!.status, 'superseded');
    assert.deepEqual(a.store.get(one.id), b.store.get(one.id));
  });

  it('recomputes both old and new claim groups after a key revision and revocation', () => {
    const a = context('left');
    const b = context('right');
    const first = remember(a, { content: 'use npm', key, method: 'user-stated' });
    remember(b, { content: 'use pnpm', key, method: 'user-stated' });
    a.store.appendOps(b.store.recentOps(100));
    const second = a.store.byKey(key.subject, key.aspect).find((m) => m.id !== first.id)!;
    a.store.appendOps([sealOp({ type: 'mem.revise', target: second.id, scope, actor: a.actor,
      payload: { parents: second.heads, key: { subject: 'other', aspect: 'manager' }, content: second.content } }, a.clock)]);
    assert.equal(a.store.get(first.id)!.status, 'committed');
    assert.deepEqual(a.store.get(first.id)!.claim_conflicts, []);
    transition(a, second.id, 'revoked');
    const before = a.store.list({ limit: 100 });
    a.store.rebuild();
    assert.deepEqual(a.store.list({ limit: 100 }), before);
  });

  it('keeps independent scopes separate and an empty scope filter returns nothing', () => {
    const a = context('left');
    remember(a, { content: 'use npm', key, method: 'user-stated' });
    const b = context('right', a.store);
    b.scopeFor = () => '/t/local/p/other';
    remember(b, { content: 'use pnpm', key, method: 'user-stated' });
    assert.ok(a.store.list().every((m) => m.status === 'committed'));
    assert.equal(a.store.list({ scopes: [] }).length, 0);
    assert.equal(a.store.search('npm', { scopes: [] }).length, 0);
  });

  it('rejects operation identity collisions atomically', () => {
    const a = context('left');
    const m = remember(a, { content: 'use npm' });
    const original = a.store.opsFor(m.id)[0]!;
    const { op_hash: _hash, ...draft } = original;
    const forged = sealOp({ ...draft, payload: { kind: 'fact', content: 'different', method: 'agent-stated' } }, a.clock);
    const extra = sealOp({ type: 'mem.meta', target: m.id, scope, actor: a.actor, payload: { pinned: true } }, a.clock);
    assert.throws(() => a.store.appendOps([extra, forged]), /collides/);
    assert.equal(a.store.get(m.id)!.pinned, false);
    assert.equal(a.store.stats().ops, 1);
  });
});

describe('safe recall and revision delivery', () => {
  it('excludes sibling conflicts even when tentative recall is requested', () => {
    const a = context('left');
    const m = remember(a, { content: 'tests use jest', method: 'user-stated' });
    a.store.appendOps(siblings(a, m.id));
    const result = recall(a, { includeTentative: true });
    assert.equal(result.items.length, 0);
    assert.equal(result.pending.review, 1);
    assert.doesNotMatch(result.text, /vitest|node:test/);
    assert.throws(() => transition(a, m.id, 'committed'), /resolve sibling/);
    assert.throws(() => resolveConflict(a, m.id, {}), /exactly one/);
    assert.throws(() => resolveConflict(a, m.id, { choose: 'invalid' }), /current sibling/);
    assert.throws(() => resolveConflict(a, m.id, { content: '  ' }), /empty/);
    const resolved = resolveConflict(a, m.id, { content: 'tests use vitest token=abcdefgh1234567890' });
    assert.equal(resolved.status, 'tentative');
    assert.doesNotMatch(JSON.stringify(a.store.opsFor(m.id)), /abcdefgh1234567890/);
    transition(a, m.id, 'committed');
    assert.equal(recall(a).items.length, 1);
  });

  it('delivers a revised or newly confirmed memory again in the same session', () => {
    const a = context('left');
    const m = remember(a, { content: 'tests use jest', method: 'user-stated' });
    const options = { session: 'left:session' };
    assert.equal(recall(a, options).items.length, 1);
    assert.equal(recall(a, options).items.length, 0);
    revise(a, m.id, 'tests use vitest');
    assert.equal(recall(a, options).items[0]!.memory.status, 'tentative');
    transition(a, m.id, 'committed');
    assert.equal(recall(a, options).items[0]!.memory.status, 'committed');
    assert.equal(recall(a, options).items.length, 0);
    a.store.clearInjections(options.session);
    assert.equal(recall(a, options).items.length, 1);
  });

  it('counts the full rendered envelope against budget and validates invalid budgets', () => {
    const a = context('left');
    remember(a, { content: 'tests run with npm test', method: 'user-stated' });
    for (const budget of [0, 1, 20, 100, 200]) {
      const result = recall(a, { budget });
      assert.ok(result.tokens <= budget);
      assert.equal(result.tokens, estimateTokens(result.text));
    }
    for (const budget of [-1, NaN, Infinity, 1.5]) assert.throws(() => recall(a, { budget }), /budget/);
  });
});
