import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hivememHome, openContext } from '../identity/context.ts';
import { remember } from '../ingest/write.ts';
import { recall } from '../recall/recall.ts';

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'SubagentStart' | 'SubagentStop' | 'Stop' | 'PreCompact' | 'SessionEnd' | 'Other';

/** Event names differ per host (Claude Code / Codex / CodeBuddy use PascalCase; Cursor and Gemini CLI use their own). */
const EVENT_ALIASES: Record<string, HookEvent> = {
  sessionstart: 'SessionStart',
  userpromptsubmit: 'UserPromptSubmit',
  userpromptsubmitted: 'UserPromptSubmit',
  beforesubmitprompt: 'UserPromptSubmit',
  beforeagent: 'UserPromptSubmit',
  subagentstart: 'SubagentStart',
  subagentstop: 'SubagentStop',
  stop: 'Stop',
  afteragent: 'Stop',
  precompact: 'PreCompact',
  precompress: 'PreCompact',
  sessionend: 'SessionEnd',
};

export interface HookPayload {
  event: HookEvent;
  rawEvent: string;
  session?: string;
  cwd?: string;
  prompt?: string;
  transcriptPath?: string;
  source?: string;
}

function pick(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

export function normalizePayload(eventArg: string | undefined, raw: Record<string, unknown>): HookPayload {
  const rawEvent = eventArg ?? pick(raw, 'hook_event_name', 'hookEventName', 'event') ?? 'Other';
  return {
    event: EVENT_ALIASES[rawEvent.replace(/[^a-z]/gi, '').toLowerCase()] ?? 'Other',
    rawEvent,
    session: pick(raw, 'session_id', 'sessionId', 'conversation_id', 'thread_id'),
    cwd: pick(raw, 'cwd', 'workdir', 'working_directory') ?? (Array.isArray(raw.workspace_roots) ? String(raw.workspace_roots[0]) : undefined),
    prompt: pick(raw, 'prompt', 'user_prompt', 'message'),
    transcriptPath: pick(raw, 'transcript_path', 'transcriptPath'),
    source: pick(raw, 'source', 'matcher'),
  };
}

/** Explicit "remember this" phrasing in a user prompt is captured as a user-stated memory (rules mode). */
const REMEMBER = /^\s*(?:请\s*)?(?:记住|记一下|覚えておいて|覚えて|기억해\s*줘|기억해|remember(?: that)?)\s*[:：,，、]?\s*(.+)$/is;

export function extractRemember(prompt: string): string | undefined {
  const m = REMEMBER.exec(prompt);
  return m?.[1]?.trim() || undefined;
}

function output(runtime: string, event: HookEvent, rawEvent: string, context: string): string {
  if (!context) return '';
  if (runtime === 'cursor') return JSON.stringify({ additional_context: context });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: rawEvent || event, additionalContext: context } });
}

function record(runtime: string, rawEvent: string, raw: unknown): void {
  const dir = join(hivememHome(), 'recordings', runtime);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${rawEvent}-${Date.now()}.json`), JSON.stringify(raw, null, 2));
}

/**
 * Entry point for every host hook. Never throws and never blocks the host: failures are logged to
 * ~/.hivemem/hook-errors.log and the hook exits with no output.
 */
export function runHook(runtime: string, eventArg: string | undefined, stdin: string, opts: { record?: boolean } = {}): string {
  try {
    const raw = (stdin.trim() ? JSON.parse(stdin) : {}) as Record<string, unknown>;
    const p = normalizePayload(eventArg, raw);
    if (opts.record || process.env.HIVEMEM_RECORD === '1') record(runtime, p.rawEvent, raw);

    const session = p.session ? `${runtime}:${p.session}` : undefined;
    const ctx = openContext({ cwd: p.cwd, runtime, session });
    try {
      switch (p.event) {
        case 'SessionStart': {
          // Restart/resume/compaction may have discarded previously injected context.
          if (session) ctx.store.clearInjections(session);
          const r = recall(ctx, { budget: 800, session });
          return output(runtime, p.event, p.rawEvent, r.text);
        }
        case 'SubagentStart': {
          const r = recall(ctx, { budget: 500, session });
          return output(runtime, p.event, p.rawEvent, r.text);
        }
        case 'UserPromptSubmit': {
          if (!p.prompt) return '';
          const note = extractRemember(p.prompt);
          if (note) remember(ctx, { content: note, method: 'user-stated' });
          const r = recall(ctx, { query: p.prompt, budget: 600, session });
          return output(runtime, p.event, p.rawEvent, r.text);
        }
        default:
          // Stop / PreCompact / SessionEnd: transcript capture lands with the ingest worker; nothing to inject.
          return '';
      }
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    try {
      mkdirSync(hivememHome(), { recursive: true });
      appendFileSync(join(hivememHome(), 'hook-errors.log'), `${new Date().toISOString()} ${runtime} ${eventArg ?? ''} ${(err as Error).stack ?? err}\n`);
    } catch {
      // logging must never break the host either
    }
    return '';
  }
}
