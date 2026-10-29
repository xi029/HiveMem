import type { Hlc } from './hlc.ts';
import { canonicalJson, sha256, ulid } from './ids.ts';
import type { Op, OpDraft } from './types.ts';

/** Content hash of an op, excluding the hash field itself. Used for dedup during sync. */
export function hashOp(op: Omit<Op, 'op_hash'>): string {
  return `s256:${sha256(canonicalJson(op))}`;
}

/** Stamp a draft with id, clock and hash. */
export function sealOp(draft: OpDraft, clock: Hlc): Op {
  const stamped = { ...draft, op_id: draft.op_id ?? ulid(), hlc: draft.hlc ?? clock.now() } as Omit<Op, 'op_hash'>;
  return { ...stamped, op_hash: hashOp(stamped) } as Op;
}

export function verifyOp(op: Op): boolean {
  const { op_hash, ...rest } = op;
  return hashOp(rest as Omit<Op, 'op_hash'>) === op_hash;
}
