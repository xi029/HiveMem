import type { MemoryState, Method, Status } from './types.ts';

export const ACTIVE: Status[] = ['committed', 'tentative', 'quarantined', 'conflicted'];

/** Preserve case and punctuation: commands, paths and identifiers are case-sensitive data. */
export function normalizeContent(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/g, '\n').trim();
}

export function authority(method: Method, untrusted = false, confirmed = false): number {
  if (untrusted) return -1;
  if (confirmed) return 3;
  return { 'user-stated': 3, 'agent-stated': 2, imported: 2, 'hook-capture': 1, 'dream-derived': 0 }[method];
}

export function memoryAuthority(m: MemoryState): number {
  return authority(m.method, m.untrusted, !!m.confirmed_by);
}

/** Derive cross-record conflicts from base folds, never from previously projected statuses. */
export function projectClaims(memories: MemoryState[]): MemoryState[] {
  const active = memories.filter((m) => ACTIVE.includes(m.base_status));
  return memories.map((m) => {
    const rivals = ACTIVE.includes(m.base_status)
      ? active.filter((other) => other.id !== m.id && normalizeContent(other.content) !== normalizeContent(m.content))
      : [];
    const blocking = rivals.filter((other) => memoryAuthority(other) >= memoryAuthority(m));
    let status = m.base_status;
    if (blocking.length && status !== 'conflicted') {
      status = blocking.some((other) => memoryAuthority(other) === memoryAuthority(m)) ? 'quarantined' : 'tentative';
    }
    return { ...m, status, claim_conflicts: blocking.map((other) => other.id).sort() };
  });
}
