export const KINDS = ['fact', 'decision', 'event', 'procedure', 'coord.baton', 'coord.claim', 'coord.question'] as const;
export type Kind = (typeof KINDS)[number];

export const STATUSES = ['tentative', 'committed', 'quarantined', 'conflicted', 'superseded', 'archived', 'revoked'] as const;
export type Status = (typeof STATUSES)[number];

export type Method = 'user-stated' | 'agent-stated' | 'hook-capture' | 'dream-derived' | 'imported';

/** Who wrote an op. Every op carries the full identity (invariant I3). */
export interface Actor {
  tenant: string;
  principal: string;
  runtime: string;
  agent: string;
  node: string;
  session?: string;
  model?: string;
}

export interface ClaimKey {
  subject: string;
  aspect: string;
}

export interface Evidence {
  type: 'session' | 'file' | 'url' | 'commit' | 'note';
  ref: string;
  digest?: string;
}

export interface CreatePayload {
  kind: Kind;
  content: string;
  method: Method;
  key?: ClaimKey;
  tags?: string[];
  importance?: number;
  evidence?: Evidence[];
  valid_from?: string;
  untrusted?: boolean;
}

export interface RevisePayload {
  content?: string;
  key?: ClaimKey | null;
  /** Versions this revision descends from (explicit parents make the fold order-independent). */
  parents: string[];
}

export interface MetaPayload {
  importance?: number;
  pinned?: boolean;
  tags_add?: string[];
  tags_remove?: string[];
  /** Another runtime's observation; runtime diversity does not prove evidence independence. */
  corroborate?: { runtime: string; session?: string; version?: string };
}

export interface TransitionPayload {
  to: Status;
  by?: string;
  /** Bind an approval to the exact content version reviewed. */
  version?: string;
  confirmed?: boolean;
}

export interface ResolvePayload {
  parents: string[];
  content?: string;
  choose?: string;
}

export interface EdgePayload {
  dst: string;
  type: EdgeType;
  weight?: number;
}

export type EdgeType = 'supersedes' | 'extends' | 'derives' | 'contradicts' | 'causes' | 'about' | 'similar';

interface OpBase {
  op_id: string;
  op_hash: string;
  hlc: string;
  actor: Actor;
  target: string;
  scope: string;
  reason?: string;
}

export type Op =
  | (OpBase & { type: 'mem.create'; payload: CreatePayload })
  | (OpBase & { type: 'mem.revise'; payload: RevisePayload })
  | (OpBase & { type: 'mem.meta'; payload: MetaPayload })
  | (OpBase & { type: 'mem.transition'; payload: TransitionPayload })
  | (OpBase & { type: 'conflict.resolve'; payload: ResolvePayload })
  | (OpBase & { type: 'edge.add'; payload: EdgePayload })
  | (OpBase & { type: 'edge.remove'; payload: EdgePayload });

export type OpType = Op['type'];
export type OpDraft = Omit<Op, 'op_id' | 'op_hash' | 'hlc'> & Partial<Pick<OpBase, 'op_id' | 'hlc'>>;

export interface Version {
  op_id: string;
  parents: string[];
  content: string;
  key?: ClaimKey;
  hlc: string;
  actor: Actor;
}

/** Projection of a memory: the deterministic fold of all ops targeting it. */
export interface MemoryState {
  id: string;
  scope: string;
  kind: Kind;
  status: Status;
  /** Status before cross-record claim-key conflict policy. */
  base_status: Status;
  claim_conflicts: string[];
  content: string;
  key?: ClaimKey;
  tags: string[];
  importance: number;
  pinned: boolean;
  method: Method;
  author: Actor;
  evidence: Evidence[];
  untrusted: boolean;
  confirmed_by?: Actor;
  corroborations: { runtime: string; session?: string; version?: string }[];
  created_hlc: string;
  revised_hlc: string;
  head: string;
  /** More than one entry means concurrent revisions are waiting for conflict.resolve. */
  heads: string[];
  versions: Version[];
  superseded_by?: string;
  valid_from?: string;
  warnings: string[];
}
