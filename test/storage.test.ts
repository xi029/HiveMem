import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { SqliteStore } from '../src/store/sqlite.ts';
import { Hlc } from '../src/ledger/hlc.ts';
import { sealOp } from '../src/ledger/op.ts';

let directory: string;
before(() => { directory = mkdtempSync(join(tmpdir(), 'hivemem-storage-')); });
after(() => { rmSync(directory, { recursive: true, force: true }); });

describe('storage upgrade and recovery', () => {
  it('upgrades the original schema without changing ops and rebuilds conflict projections', () => {
    const path = join(directory, 'legacy.db');
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE ops (op_id TEXT PRIMARY KEY, op_hash TEXT UNIQUE NOT NULL, tenant TEXT NOT NULL, hlc TEXT NOT NULL,
        node TEXT NOT NULL, type TEXT NOT NULL, target TEXT NOT NULL, scope TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE memories (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
        key_subject TEXT, key_aspect TEXT, content TEXT NOT NULL, importance INTEGER NOT NULL, pinned INTEGER NOT NULL,
        method TEXT NOT NULL, runtime TEXT NOT NULL, created_hlc TEXT NOT NULL, revised_hlc TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE injections (session TEXT NOT NULL, memory_id TEXT NOT NULL, tokens INTEGER NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY(session, memory_id));
      INSERT INTO injections VALUES ('session', 'one', 10, '2026-01-01');
    `);
    const actor = { tenant: 'local', principal: 'user:test', runtime: 'cli', agent: 'cli/main', node: 'legacy' };
    const scope = '/t/local/p/legacy';
    const clock = new Hlc('legacy');
    const ops = ['npm', 'pnpm'].flatMap((content, index) => {
      const create = sealOp({ actor, scope, target: `m${index}`, type: 'mem.create',
        payload: { kind: 'fact', content, method: 'user-stated', key: { subject: 'project', aspect: 'manager' } } }, clock);
      const approve = sealOp({ actor, scope, target: create.target, type: 'mem.transition', payload: { to: 'committed' } }, clock);
      return [create, approve];
    });
    const insert = db.prepare('INSERT INTO ops VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const op of ops) insert.run(op.op_id, op.op_hash, actor.tenant, op.hlc, actor.node, op.type, op.target, scope, JSON.stringify(op));
    db.close();

    let store = new SqliteStore(path);
    try {
      assert.equal(store.getMeta('projection_version'), '2');
      assert.equal(store.stats().byStatus.quarantined, 2);
      assert.equal(store.exact('npm', scope, 'fact', { subject: 'project', aspect: 'manager' }).length, 1);
      assert.equal(store.injected('session').get('one'), '', 'legacy receipts cannot suppress a current version');
      assert.deepEqual(store.recentOps(10).reverse(), ops);
      const before = store.list();
      store.db.exec('DELETE FROM memories_fts');
      store.rebuild();
      assert.deepEqual(store.list(), before);
      assert.equal(store.search('npm').length, 1);
    } finally { store.close(); }
    store = new SqliteStore(path);
    try { assert.equal(store.stats().byStatus.quarantined, 2); }
    finally { store.close(); }
  });
});

describe('concurrent local writers', () => {
  it('serializes admission and deduplication across real processes', async () => {
    const taskHome = join(directory, 'concurrent');
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    // Initialize the machine identity before the writers start.
    const { openContext } = await import('../src/identity/context.ts');
    const previousHome = process.env.HIVEMEM_HOME;
    process.env.HIVEMEM_HOME = taskHome;
    try { const ctx = openContext({ cwd }); ctx.store.close(); }
    finally {
      if (previousHome === undefined) delete process.env.HIVEMEM_HOME;
      else process.env.HIVEMEM_HOME = previousHome;
    }
    const entry = new URL('../src/identity/context.ts', import.meta.url).href;
    const ingest = new URL('../src/ingest/write.ts', import.meta.url).href;
    const code = `import {openContext} from ${JSON.stringify(entry)};
      import {remember} from ${JSON.stringify(ingest)};
      const ctx = openContext({runtime:process.argv[1]});
      process.stdout.write('ready\\n');
      process.stdin.once('data', () => { try {
        const result=remember(ctx,{content:'tests use npm test',key:{subject:'project',aspect:'test.command'}});
        process.stdout.write(JSON.stringify(result)+'\\n');
      } finally {ctx.store.close(); process.stdin.destroy();} });`;
    const workers = ['claude-code', 'codex', 'codebuddy'].map((runtime) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, runtime], {
        cwd, env: { ...process.env, HIVEMEM_HOME: taskHome }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      let ready!: () => void;
      let failReady!: (err: Error) => void;
      const started = new Promise<void>((resolve, reject) => { ready = resolve; failReady = reject; });
      child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.includes('ready\n')) ready(); });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const done = new Promise<void>((resolve, reject) => {
        child.on('error', (err) => { failReady(err); reject(err); });
        child.on('close', (status) => {
          if (status === 0) resolve();
          else { const err = new Error(stderr || `child exited ${status}`); failReady(err); reject(err); }
        });
      });
      // Attach a handler immediately, even if a worker exits before all readiness signals arrive.
      void done.catch(() => {});
      return { child, started, done };
    });
    const timer = setTimeout(() => { for (const worker of workers) worker.child.kill(); }, 15_000);
    try {
      await Promise.all(workers.map((w) => w.started));
      for (const worker of workers) worker.child.stdin.end('go');
      await Promise.all(workers.map((w) => w.done));
      const store = new SqliteStore(join(taskHome, 'hivemem.db'));
      try {
        const rows = store.list();
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.status, 'committed');
        assert.equal(rows[0]!.corroborations.length, 2);
      } finally { store.close(); }
    } finally {
      clearTimeout(timer);
      for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
      await Promise.allSettled(workers.map((w) => w.done));
    }
  });
});
