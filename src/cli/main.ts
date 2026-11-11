#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import type { ClaimKey, Kind, MemoryState, Method, Status } from '../ledger/types.ts';
import { KINDS } from '../ledger/types.ts';
import { type Ctx, hivememHome, openContext, type ScopeLevel } from '../identity/context.ts';
import { remember, resolveConflict, revise, setMeta, transition } from '../ingest/write.ts';
import { recall, renderLine } from '../recall/recall.ts';
import { runHook } from '../hooks/hook.ts';
import { setupText, TARGETS } from '../hooks/setup.ts';
import { type Args, parseArgs, str } from './args.ts';

const HELP = `hivemem - shared memory for all your agents

Usage:
  hivemem remember <text> [--kind fact|decision|event|procedure] [--key subject:aspect]
                          [--scope project|user|agent] [--as user|agent] [--tags a,b] [--importance 1-5]
  hivemem recall <query> [--budget 1200] [--tentative] [--json]
  hivemem brief                      what a new session in this project would see
  hivemem list [--status s] [--kind k] [--all]
  hivemem show <id>                  versions, provenance and ops
  hivemem inbox                      tentative, conflicted and quarantined memories
  hivemem confirm|forget|archive <id>
  hivemem revise <id> <text>          creates a tentative version; review and confirm it
  hivemem resolve <id> (--choose <version-op-id> | --content <text>)  then confirm
  hivemem pin|unpin <id>
  hivemem log [--limit 20]
  hivemem project                    identity of the current project
  hivemem stats
  hivemem rebuild                    rebuild projections and search indexes from the ledger
  hivemem hook <event> --runtime claude-code|codex|codebuddy|cursor [--record]   (reads JSON on stdin)
  hivemem setup [--target claude-code,codex,codebuddy]   print hook config to paste into each tool

Options: --runtime <name> (default: cli)  --cwd <dir>  --json
Data: ${hivememHome()}`;

const BOOLEANS = new Set(['json', 'all', 'record', 'help', 'tentative']);

function parseKey(v?: string): ClaimKey | undefined {
  if (!v) return undefined;
  const i = v.indexOf(':');
  if (i <= 0 || i === v.length - 1) throw new Error('--key must look like subject:aspect, e.g. project:naming.api_field_case');
  return { subject: v.slice(0, i), aspect: v.slice(i + 1) };
}

function needId(ctx: Ctx, a: Args): string {
  const raw = a.positional[1];
  if (!raw) throw new Error('missing <id>');
  const id = ctx.store.get(raw) ? raw : ctx.store.resolveId(raw);
  if (!id) throw new Error(`no unique memory matches "${raw}"`);
  return id;
}

function print(a: Args, data: unknown, human: () => string): void {
  console.log(a.flags.json ? JSON.stringify(data, null, 2) : human());
}

function short(m: MemoryState): string {
  return `${m.id.slice(-6)}  ${m.status.padEnd(11)} ${m.kind.padEnd(9)} ${m.content.replace(/\s+/g, ' ').slice(0, 90)}`;
}

function main(argv: string[]): number {
  const a = parseArgs(argv, BOOLEANS);
  const cmd = a.positional[0];
  if (!cmd || a.flags.help || cmd === 'help') {
    console.log(HELP);
    return 0;
  }

  if (cmd === 'setup') {
    const targets = (str(a.flags, 'target') ?? Object.keys(TARGETS).join(',')).split(',').map((t) => t.trim());
    console.log(setupText(targets, str(a.flags, 'bin') ?? 'hivemem'));
    return 0;
  }

  if (cmd === 'hook') {
    const runtime = str(a.flags, 'runtime') ?? 'claude-code';
    let stdin = '';
    try {
      stdin = readFileSync(0, 'utf8');
    } catch {
      // no stdin
    }
    const out = runHook(runtime, a.positional[1], stdin, { record: !!a.flags.record });
    if (out) process.stdout.write(out);
    return 0;
  }

  const ctx = openContext({ cwd: str(a.flags, 'cwd'), runtime: str(a.flags, 'runtime') });
  try {
    switch (cmd) {
      case 'remember': {
        const content = a.positional.slice(1).join(' ');
        const kind = (str(a.flags, 'kind') ?? 'fact') as Kind;
        if (!KINDS.includes(kind)) throw new Error(`unknown kind ${kind}`);
        const as = str(a.flags, 'as') ?? (ctx.actor.runtime === 'cli' ? 'user' : 'agent');
        if (as !== 'user' && as !== 'agent') throw new Error('--as must be user or agent');
        const method: Method = as === 'user' ? 'user-stated' : 'agent-stated';
        const level = ({ project: 'project', user: 'user', agent: 'agent', private: 'user-project' } as Record<string, ScopeLevel>)[str(a.flags, 'scope') ?? 'project'];
        if (!level) throw new Error('--scope must be project, user, agent or private');
        const r = remember(ctx, {
          content,
          kind,
          method,
          level,
          key: parseKey(str(a.flags, 'key')),
          tags: str(a.flags, 'tags')?.split(',').map((t) => t.trim()).filter(Boolean),
          importance: str(a.flags, 'importance') ? Number(str(a.flags, 'importance')) : undefined,
        });
        print(a, r, () => {
          const lines = [`${r.action} ${r.id.slice(-6)} (${r.status})`];
          if (r.superseded.length) lines.push(`  superseded: ${r.superseded.map((s) => s.slice(-6)).join(', ')}`);
          if (r.contradicts.length) lines.push(`  contradicts: ${r.contradicts.map((s) => s.slice(-6)).join(', ')} -> see \`hivemem inbox\``);
          if (r.redacted.length) lines.push(`  redacted secrets: ${r.redacted.join(', ')}`);
          return lines.join('\n');
        });
        return 0;
      }
      case 'recall': {
        const r = recall(ctx, { query: a.positional.slice(1).join(' '), budget: Number(str(a.flags, 'budget') ?? 1200), includeTentative: !!a.flags.tentative });
        print(a, { ...r, items: r.items.map((i) => ({ id: i.memory.id, score: i.score, signals: i.signals, line: i.line })) }, () => r.text || '(nothing relevant)');
        return 0;
      }
      case 'brief': {
        const r = recall(ctx, { budget: Number(str(a.flags, 'budget') ?? 800) });
        print(a, r.items.map((i) => i.memory.id), () => r.text || '(no memories yet for this project)');
        return 0;
      }
      case 'list':
      case 'inbox': {
        const statuses = cmd === 'inbox' ? (['tentative', 'conflicted', 'quarantined'] as Status[]) : str(a.flags, 'status') ? [str(a.flags, 'status') as Status] : undefined;
        const kinds = str(a.flags, 'kind') ? [str(a.flags, 'kind') as Kind] : undefined;
        const ms = ctx.store.list({ scopes: a.flags.all ? undefined : ctx.chain.map((c) => c.scope), statuses, kinds, limit: 200 });
        print(a, ms, () => (ms.length ? ms.map(short).join('\n') : '(empty)'));
        return 0;
      }
      case 'show': {
        const id = needId(ctx, a);
        const m = ctx.store.get(id)!;
        const ops = ctx.store.opsFor(id);
        print(a, { memory: m, ops }, () =>
          [
            renderLine(m),
            `id ${m.id}  scope ${m.scope}`,
            `status ${m.status}  kind ${m.kind}  importance ${m.importance}${m.pinned ? '  pinned' : ''}${m.key ? `  key ${m.key.subject}:${m.key.aspect}` : ''}`,
            `author ${m.author.principal} via ${m.author.agent}${m.corroborations.length ? `  corroborated by ${m.corroborations.map((c) => c.runtime).join(', ')}` : ''}`,
            m.confirmed_by ? `confirmed by ${m.confirmed_by.principal} via ${m.confirmed_by.runtime}` : '',
            m.heads.length > 1 ? `CONFLICT - versions:\n${m.versions.filter((v) => m.heads.includes(v.op_id)).map((v) => `  ${v.op_id} (${v.actor.runtime}): ${v.content}`).join('\n')}` : '',
            m.claim_conflicts.length ? `CLAIM CONFLICT - memories: ${m.claim_conflicts.join(', ')}; review with show, then confirm the correct memory` : '',
            'ops:',
            ...ops.map((o) => `  ${o.hlc.slice(0, 13)} ${o.type.padEnd(16)} ${o.actor.runtime.padEnd(12)} ${o.reason ?? ''}`),
            m.warnings.length ? `warnings: ${m.warnings.join('; ')}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
        return 0;
      }
      case 'confirm':
      case 'forget':
      case 'archive': {
        const to: Status = cmd === 'confirm' ? 'committed' : cmd === 'forget' ? 'revoked' : 'archived';
        const m = transition(ctx, needId(ctx, a), to, `${cmd} via ${ctx.actor.runtime}`);
        print(a, m, () => short(m));
        return 0;
      }
      case 'revise': {
        const m = revise(ctx, needId(ctx, a), a.positional.slice(2).join(' '));
        print(a, m, () => short(m));
        return 0;
      }
      case 'resolve': {
        const m = resolveConflict(ctx, needId(ctx, a), { choose: str(a.flags, 'choose'), content: str(a.flags, 'content') });
        print(a, m, () => short(m));
        return 0;
      }
      case 'pin':
      case 'unpin': {
        const m = setMeta(ctx, needId(ctx, a), { pinned: cmd === 'pin' });
        print(a, m, () => short(m));
        return 0;
      }
      case 'log': {
        const ops = ctx.store.recentOps(Number(str(a.flags, 'limit') ?? 20));
        print(a, ops, () => ops.map((o) => `${o.hlc.slice(0, 13)} ${o.type.padEnd(16)} ${o.target.slice(-6)} ${o.actor.runtime.padEnd(12)} ${o.reason ?? ''}`).join('\n'));
        return 0;
      }
      case 'project': {
        print(a, ctx.project, () => `${ctx.project.id}  ${ctx.project.display}  (${ctx.project.source})\nroot ${ctx.project.root}`);
        return 0;
      }
      case 'stats': {
        const s = ctx.store.stats();
        print(a, s, () => `${s.memories} memories, ${s.ops} ops  ${JSON.stringify(s.byStatus)}`);
        return 0;
      }
      case 'rebuild': {
        ctx.store.rebuild();
        print(a, ctx.store.stats(), () => 'Rebuilt memory projections and search indexes from the ledger.');
        return 0;
      }
      default:
        console.error(`unknown command: ${cmd}\n\n${HELP}`);
        return 2;
    }
  } finally {
    ctx.store.close();
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(`hivemem: ${(err as Error).message}`);
  process.exitCode = 1;
}
