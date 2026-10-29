import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openContext, type Ctx } from '../src/identity/context.ts';
import { normalizeRemote } from '../src/identity/project.ts';
import { extractRemember, runHook } from '../src/hooks/hook.ts';
import { redact } from '../src/ingest/redact.ts';
import { remember } from '../src/ingest/write.ts';
import { recall } from '../src/recall/recall.ts';
import { ftsQuery, indexText } from '../src/store/tokenize.ts';

let home: string;
let cwd: string;
let n = 0;

before(() => {
  home = mkdtempSync(join(tmpdir(), 'hivemem-test-'));
  cwd = mkdtempSync(join(tmpdir(), 'hivemem-proj-'));
  process.env.HIVEMEM_HOME = home;
});
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** Each test gets its own database; `as(runtime)` opens a context for that tool on the same database. */
function fresh(): (runtime: string, session?: string) => Ctx {
  const dbPath = join(home, `t${n++}.db`);
  return (runtime, session) => openContext({ cwd, runtime, session, dbPath });
}

function withCtx<T>(open: Ctx, fn: (c: Ctx) => T): T {
  try {
    return fn(open);
  } finally {
    open.store.close();
  }
}

describe('tokenizer', () => {
  it('matches 2-character CJK words regardless of surrounding text', () => {
    assert.match(indexText('后端 API 字段统一使用 snake_case'), /字段/);
    assert.match(ftsQuery('新接口的字段怎么命名？')!, /"字段"/);
    assert.doesNotMatch(ftsQuery('新接口的字段怎么命名？')!, /"怎么"/);
  });
});

describe('write path', () => {
  it('commits user statements and keeps agent statements tentative', () => {
    const as = fresh();
    withCtx(as('claude-code'), (c) => {
      assert.equal(remember(c, { content: 'API 字段用 snake_case', method: 'user-stated' }).status, 'committed');
      assert.equal(remember(c, { content: '测试命令是 npm test', method: 'agent-stated' }).status, 'tentative');
    });
  });

  it('resolves the short ids the CLI prints (suffix) as well as prefixes', () => {
    const as = fresh();
    withCtx(as('cli'), (c) => {
      const { id } = remember(c, { content: 'Indent with 2 spaces', method: 'user-stated' });
      assert.equal(c.store.resolveId(id.slice(-6).toLowerCase()), id);
      assert.equal(c.store.resolveId(id.slice(0, 12)), id);
    });
  });

  it('commits an agent statement once a second runtime corroborates it', () => {
    const as = fresh();
    const fact = { content: '测试命令是 npm test', method: 'agent-stated' as const };
    const first = withCtx(as('claude-code'), (c) => remember(c, fact));
    const again = withCtx(as('claude-code'), (c) => remember(c, fact));
    assert.equal(again.action, 'reinforced');
    assert.equal(again.status, 'tentative');
    const other = withCtx(as('codex'), (c) => remember(c, fact));
    assert.equal(other.id, first.id);
    assert.equal(other.action, 'corroborated');
    assert.equal(other.status, 'committed');
  });

  it('resolves claim-key conflicts by authority', () => {
    const as = fresh();
    const key = { subject: 'project', aspect: 'pkg.manager' };
    withCtx(as('claude-code'), (c) => {
      const a = remember(c, { content: 'use pnpm', key, method: 'agent-stated' });
      const b = remember(c, { content: 'use npm', key, method: 'agent-stated' });
      assert.equal(b.status, 'quarantined');
      assert.equal(c.store.get(a.id)!.status, 'quarantined');
      const u = remember(c, { content: 'use bun', key, method: 'user-stated' });
      assert.equal(u.status, 'committed');
      assert.deepEqual(new Set(u.superseded), new Set([a.id, b.id]));
      const late = remember(c, { content: 'use yarn', key, method: 'agent-stated' });
      assert.equal(late.status, 'tentative');
      assert.deepEqual(late.contradicts, [u.id]);
    });
  });

  it('redacts secrets once, before they reach the ledger', () => {
    const r = redact('token=ghp_abcdefghijklmnopqrstuvwxyz0123456789AB and sk-ant-REDACTEDREDACTEDREDACTED');
    assert.deepEqual(r.hits, ['anthropic-key', 'github-token']);
    assert.doesNotMatch(r.text, /ghp_|sk-ant-/);
  });
});

describe('recall', () => {
  it('finds memories across languages, stems English, and dedupes per session', () => {
    const as = fresh();
    withCtx(as('claude-code'), (c) => {
      remember(c, { content: '后端 API 字段统一使用 snake_case', method: 'user-stated' });
      remember(c, { content: 'Run the suite with npm test', method: 'user-stated' });
    });
    withCtx(as('codex', 'codex:s1'), (c) => {
      const zh = recall(c, { query: '新接口的字段怎么命名？', session: 'codex:s1' });
      assert.equal(zh.items.length, 1);
      assert.match(zh.text, /snake_case/);
      assert.equal(recall(c, { query: '字段命名', session: 'codex:s1' }).items.length, 0, 'already injected this session');
      assert.match(recall(c, { query: 'how do I run tests' }).text, /npm test/);
    });
  });

  it('hides tentative memories from other agents', () => {
    const as = fresh();
    withCtx(as('claude-code'), (c) => remember(c, { content: '可能要把 lodash 换掉', method: 'agent-stated' }));
    withCtx(as('claude-code'), (c) => assert.equal(recall(c, { query: 'lodash' }).items.length, 1));
    withCtx(as('codex'), (c) => assert.equal(recall(c, { query: 'lodash' }).items.length, 0));
  });
});

describe('hooks', () => {
  it('captures "记住" prompts and injects context in the Claude/Codex/CodeBuddy format', () => {
    process.env.HIVEMEM_HOME = join(home, `hook${n++}`);
    const prompt = JSON.stringify({ session_id: 's1', cwd, prompt: '记住：所有时间都用 UTC 存储' });
    const out = JSON.parse(runHook('claude-code', 'UserPromptSubmit', prompt));
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(out.hookSpecificOutput.additionalContext, /UTC/);
    const start = JSON.parse(runHook('codebuddy', 'SessionStart', JSON.stringify({ session_id: 'cb', cwd })));
    assert.match(start.hookSpecificOutput.additionalContext, /UTC/);
    const cursor = JSON.parse(runHook('cursor', 'sessionStart', JSON.stringify({ conversation_id: 'cu', workspace_roots: [cwd] })));
    assert.match(cursor.additional_context, /UTC/);
    process.env.HIVEMEM_HOME = home;
  });

  it('never throws on malformed input', () => {
    assert.equal(runHook('codex', 'UserPromptSubmit', '{not json'), '');
  });

  it('extracts explicit remember phrasing only', () => {
    assert.equal(extractRemember('记住：用 pnpm'), '用 pnpm');
    assert.equal(extractRemember('remember that we deploy on Fridays'), 'we deploy on Fridays');
    assert.equal(extractRemember('覚えておいて：API は snake_case'), 'API は snake_case');
    assert.equal(extractRemember('기억해 줘: 배포는 금요일'), '배포는 금요일');
    assert.equal(extractRemember('你还记得上次的报错吗'), undefined);
  });
});

describe('project identity', () => {
  it('normalises remotes so every clone maps to one project', () => {
    const want = 'github.com/acme/api';
    for (const url of ['git@github.com:Acme/API.git', 'https://github.com/acme/api', 'https://user@github.com/acme/api.git/', 'ssh://git@github.com:22/acme/api.git']) {
      assert.equal(normalizeRemote(url), want, url);
    }
  });
});
