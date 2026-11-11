import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { foldMemory } from '../ledger/fold.ts';
import { normalizeContent, projectClaims } from '../ledger/claims.ts';
import { verifyOp } from '../ledger/op.ts';
import type { ClaimKey, EdgeType, Kind, MemoryState, Op, Status } from '../ledger/types.ts';
import { ftsQuery, indexText } from './tokenize.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ops (
  op_id TEXT PRIMARY KEY, op_hash TEXT UNIQUE NOT NULL, tenant TEXT NOT NULL, hlc TEXT NOT NULL,
  node TEXT NOT NULL, type TEXT NOT NULL, target TEXT NOT NULL, scope TEXT NOT NULL, body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ops_target ON ops(target, hlc);
CREATE INDEX IF NOT EXISTS ops_hlc ON ops(hlc);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, tenant TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
  key_subject TEXT, key_aspect TEXT, content TEXT NOT NULL, importance INTEGER NOT NULL, pinned INTEGER NOT NULL,
  method TEXT NOT NULL, runtime TEXT NOT NULL, created_hlc TEXT NOT NULL, revised_hlc TEXT NOT NULL, state TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mem_scope ON memories(scope, status, kind);
CREATE INDEX IF NOT EXISTS mem_key ON memories(key_subject, key_aspect);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, text, tokenize='porter unicode61');
CREATE TABLE IF NOT EXISTS edges (src TEXT NOT NULL, dst TEXT NOT NULL, type TEXT NOT NULL, weight REAL, op_id TEXT NOT NULL,
  PRIMARY KEY (src, dst, type));
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);
CREATE TABLE IF NOT EXISTS injections (session TEXT NOT NULL, memory_id TEXT NOT NULL, tokens INTEGER NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (session, memory_id));
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, display TEXT, remote_norm TEXT, root_commit TEXT, path TEXT, seen TEXT);
`;

export interface MemoryFilter {
  scopes?: string[];
  statuses?: Status[];
  kinds?: Kind[];
  limit?: number;
}

export interface Edge {
  src: string;
  dst: string;
  type: EdgeType;
  weight: number | null;
}

type Row = Record<string, string | number | null>;

/** Local store: the op log is the source of truth; every other table is a projection rebuilt from it. */
export class SqliteStore {
  readonly db: DatabaseSync;
  private inTransaction = false;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      // Journal initialization can contend with another opener or WAL recovery too.
      this.db.exec('PRAGMA busy_timeout=5000;');
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
      this.db.exec(SCHEMA);
      this.transaction(() => {
        const columns = (table: string) => (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => r.name);
        if (!columns('memories').includes('content_norm')) this.db.exec("ALTER TABLE memories ADD COLUMN content_norm TEXT NOT NULL DEFAULT ''");
        if (!columns('injections').includes('version')) this.db.exec("ALTER TABLE injections ADD COLUMN version TEXT NOT NULL DEFAULT ''");
        this.db.exec('CREATE INDEX IF NOT EXISTS mem_content ON memories(scope, content_norm)');
        if (this.getMeta('projection_version') !== '2') {
          this.rebuild();
          this.setMeta('projection_version', '2');
        }
      });
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  /** Lock before reading admission state, so concurrent writers cannot validate stale snapshots. */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  close(): void {
    this.db.close();
  }

  getMeta(k: string): string | undefined {
    const row = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as Row | undefined;
    return row?.v as string | undefined;
  }

  setMeta(k: string, v: string): void {
    this.db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  /** Append ops idempotently (dedup by hash) and refresh the projections they touch, in one transaction. */
  appendOps(ops: readonly Op[]): string[] {
    return this.transaction(() => this.appendInTransaction(ops));
  }

  private appendInTransaction(ops: readonly Op[]): string[] {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO ops(op_id, op_hash, tenant, hlc, node, type, target, scope, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const applied: string[] = [];
    const targets = new Set<string>();
    const groups = new Map<string, { scope: string; key: ClaimKey }>();
    const collect = (m?: MemoryState) => {
      if (m?.key) groups.set(JSON.stringify([m.scope, m.key.subject, m.key.aspect]), { scope: m.scope, key: m.key });
    };
    for (const op of ops) {
      if (!verifyOp(op)) throw new Error(`op ${op.op_id} failed hash verification`);
      const existing = this.db.prepare('SELECT op_hash FROM ops WHERE op_id = ?').get(op.op_id) as Row | undefined;
      if (existing && existing.op_hash !== op.op_hash) throw new Error(`op ${op.op_id} collides with an existing operation`);
      const res = insert.run(op.op_id, op.op_hash, op.actor.tenant, op.hlc, op.actor.node, op.type, op.target, op.scope, JSON.stringify(op));
      if (res.changes > 0) {
        applied.push(op.op_id);
        targets.add(op.target);
      }
    }
    for (const id of targets) {
      collect(this.get(id));
      this.refresh(id);
      collect(this.get(id));
    }
    for (const { scope, key } of groups.values()) this.refreshClaim(scope, key);
    const latest = this.recentOps(1)[0];
    if (latest) this.setMeta('last_hlc', latest.hlc);
    return applied;
  }

  /** Rebuild derived state after an upgrade or for local recovery; original ops stay unchanged. */
  rebuild(): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM memories; DELETE FROM memories_fts; DELETE FROM edges');
      const ids = this.db.prepare('SELECT DISTINCT target FROM ops ORDER BY target').all() as Row[];
      for (const row of ids) this.refresh(row.target as string);
      const groups = this.db.prepare('SELECT DISTINCT scope, key_subject, key_aspect FROM memories WHERE key_subject IS NOT NULL').all() as Row[];
      for (const row of groups) this.refreshClaim(row.scope as string, { subject: row.key_subject as string, aspect: row.key_aspect as string });
      const latest = this.recentOps(1)[0];
      if (latest) this.setMeta('last_hlc', latest.hlc);
    });
  }

  private refreshClaim(scope: string, key: ClaimKey): void {
    const states = this.byKey(key.subject, key.aspect, { scopes: [scope] })
      .map((m) => foldMemory(this.opsFor(m.id))).filter((m): m is MemoryState => m !== null);
    for (const state of projectClaims(states)) this.writeState(state);
  }

  opsFor(target: string): Op[] {
    const rows = this.db.prepare('SELECT body FROM ops WHERE target = ? ORDER BY hlc, op_id').all(target) as Row[];
    return rows.map((r) => JSON.parse(r.body as string) as Op);
  }

  recentOps(limit = 50): Op[] {
    const rows = this.db.prepare('SELECT body FROM ops ORDER BY hlc DESC, op_id DESC LIMIT ?').all(limit) as Row[];
    return rows.map((r) => JSON.parse(r.body as string) as Op);
  }

  /** Recompute every projection for one target from its ops. */
  private refresh(id: string): void {
    const ops = this.opsFor(id);
    const state = foldMemory(ops);
    if (state) this.writeState(state);
    this.refreshEdges(id, ops);
  }

  private writeState(state: MemoryState): void {
    const id = state.id;
    this.db.prepare('DELETE FROM memories_fts WHERE id = ?').run(id);
    this.db
      .prepare(
        `INSERT INTO memories(id, tenant, scope, kind, status, key_subject, key_aspect, content, importance, pinned, method, runtime, created_hlc, revised_hlc, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET tenant=excluded.tenant, created_hlc=excluded.created_hlc,
           scope=excluded.scope, kind=excluded.kind, status=excluded.status, key_subject=excluded.key_subject,
           key_aspect=excluded.key_aspect, content=excluded.content, importance=excluded.importance, pinned=excluded.pinned,
           method=excluded.method, runtime=excluded.runtime, revised_hlc=excluded.revised_hlc, state=excluded.state`,
      )
      .run(
        id, state.author.tenant, state.scope, state.kind, state.status, state.key?.subject ?? null, state.key?.aspect ?? null,
        state.content, state.importance, state.pinned ? 1 : 0, state.method, state.author.runtime, state.created_hlc, state.revised_hlc,
        JSON.stringify(state),
      );
    this.db.prepare('INSERT INTO memories_fts(id, text) VALUES (?, ?)').run(id, indexText(state.content, state.key?.aspect, state.tags.join(' ')));
    this.db.prepare('UPDATE memories SET content_norm = ? WHERE id = ?').run(normalizeContent(state.content), id);
  }

  private refreshEdges(src: string, ops: Op[]): void {
    const live = new Map<string, Op>();
    for (const op of ops) {
      if (op.type !== 'edge.add' && op.type !== 'edge.remove') continue;
      const k = `${op.payload.dst}\u0000${op.payload.type}`;
      if (op.type === 'edge.add') live.set(k, op);
      else live.delete(k);
    }
    this.db.prepare('DELETE FROM edges WHERE src = ?').run(src);
    const ins = this.db.prepare('INSERT INTO edges(src, dst, type, weight, op_id) VALUES (?, ?, ?, ?, ?)');
    for (const op of live.values()) {
      if (op.type === 'edge.add') ins.run(src, op.payload.dst, op.payload.type, op.payload.weight ?? null, op.op_id);
    }
  }

  get(id: string): MemoryState | undefined {
    const row = this.db.prepare('SELECT state FROM memories WHERE id = ?').get(id) as Row | undefined;
    return row ? (JSON.parse(row.state as string) as MemoryState) : undefined;
  }

  exact(content: string, scope: string, kind: Kind, key?: ClaimKey): MemoryState[] {
    const rows = this.db.prepare(`SELECT state FROM memories WHERE scope = ? AND content_norm = ? AND kind = ?
      AND key_subject IS ? AND key_aspect IS ? ORDER BY id`).all(scope, normalizeContent(content), kind, key?.subject ?? null, key?.aspect ?? null) as Row[];
    return rows.map((r) => JSON.parse(r.state as string) as MemoryState);
  }

  /** Resolve a unique id prefix or suffix (ULIDs are long; the CLI shows the last 6 characters). */
  resolveId(part: string): string | undefined {
    const p = part.toUpperCase();
    const rows = this.db.prepare('SELECT id FROM memories WHERE id LIKE ? OR id LIKE ? LIMIT 2').all(`${p}%`, `%${p}`) as Row[];
    return rows.length === 1 ? (rows[0]!.id as string) : undefined;
  }

  list(f: MemoryFilter = {}, order: 'recent' | 'importance' = 'recent'): MemoryState[] {
    const { where, args } = filterSql(f);
    const by = order === 'recent' ? 'revised_hlc DESC' : 'pinned DESC, importance DESC, revised_hlc DESC';
    const rows = this.db.prepare(`SELECT state FROM memories ${where} ORDER BY ${by}, id LIMIT ?`).all(...args, f.limit ?? 100) as Row[];
    return rows.map((r) => JSON.parse(r.state as string) as MemoryState);
  }

  byKey(subject: string, aspect: string, f: MemoryFilter = {}): MemoryState[] {
    const { where, args } = filterSql(f, ['key_subject = ?', 'key_aspect = ?'], [subject, aspect]);
    const rows = this.db.prepare(`SELECT state FROM memories ${where} ORDER BY revised_hlc DESC, id`).all(...args) as Row[];
    return rows.map((r) => JSON.parse(r.state as string) as MemoryState);
  }

  /** Full-text search; returns ids with a BM25 score (higher is better). */
  search(text: string, f: MemoryFilter = {}): { id: string; score: number }[] {
    const q = ftsQuery(text);
    if (!q) return [];
    const { where, args } = filterSql(f, ['memories_fts MATCH ?'], [q], 'm.');
    const rows = this.db
      .prepare(`SELECT m.id AS id, bm25(memories_fts) AS rank FROM memories_fts JOIN memories m ON m.id = memories_fts.id ${where} ORDER BY rank LIMIT ?`)
      .all(...args, f.limit ?? 50) as Row[];
    return rows.map((r) => ({ id: r.id as string, score: -(r.rank as number) }));
  }

  edgesFrom(ids: string[]): Edge[] {
    if (!ids.length) return [];
    const marks = ids.map(() => '?').join(',');
    return this.db.prepare(`SELECT src, dst, type, weight FROM edges WHERE src IN (${marks}) OR dst IN (${marks})`).all(...ids, ...ids) as unknown as Edge[];
  }

  injected(session: string): Map<string, string> {
    const rows = this.db.prepare('SELECT memory_id, version FROM injections WHERE session = ?').all(session) as Row[];
    return new Map(rows.map((r) => [r.memory_id as string, r.version as string]));
  }

  clearInjections(session: string): void {
    this.db.prepare('DELETE FROM injections WHERE session = ?').run(session);
  }

  recordInjection(session: string, items: { id: string; version: string; tokens: number }[]): void {
    const ins = this.db.prepare(`INSERT INTO injections(session, memory_id, tokens, at, version) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session, memory_id) DO UPDATE SET tokens=excluded.tokens, at=excluded.at, version=excluded.version`);
    const at = new Date().toISOString();
    for (const it of items) ins.run(session, it.id, it.tokens, at, it.version);
  }

  upsertProject(p: { id: string; display: string; remote_norm?: string; root_commit?: string; path: string }): void {
    this.db
      .prepare(
        `INSERT INTO projects(id, display, remote_norm, root_commit, path, seen) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET display=excluded.display, path=excluded.path, seen=excluded.seen`,
      )
      .run(p.id, p.display, p.remote_norm ?? null, p.root_commit ?? null, p.path, new Date().toISOString());
  }

  stats(): { ops: number; memories: number; byStatus: Record<string, number> } {
    const ops = (this.db.prepare('SELECT count(*) AS n FROM ops').get() as Row).n as number;
    const rows = this.db.prepare('SELECT status, count(*) AS n FROM memories GROUP BY status').all() as Row[];
    const byStatus = Object.fromEntries(rows.map((r) => [r.status as string, r.n as number]));
    return { ops, memories: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus };
  }
}

function filterSql(f: MemoryFilter, extra: string[] = [], extraArgs: (string | number)[] = [], prefix = ''): { where: string; args: (string | number)[] } {
  const clauses = [...extra];
  const args: (string | number)[] = [...extraArgs];
  const inList = (col: string, vals?: readonly string[]) => {
    if (!vals) return;
    if (!vals.length) { clauses.push('0'); return; }
    clauses.push(`${prefix}${col} IN (${vals.map(() => '?').join(',')})`);
    args.push(...vals);
  };
  inList('scope', f.scopes);
  inList('status', f.statuses);
  inList('kind', f.kinds);
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', args };
}
