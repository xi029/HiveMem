/**
 * Hybrid logical clock. Encoded as `<13-digit ms>-<4-digit counter>-<node>` so that plain
 * string comparison gives the total order (time, counter, node) used by the fold.
 */
export interface HlcState {
  wall: number;
  counter: number;
}

export class Hlc {
  private state: HlcState = { wall: 0, counter: 0 };
  readonly node: string;
  private readonly clock: () => number;

  constructor(node: string, clock: () => number = Date.now) {
    this.node = node;
    this.clock = clock;
  }

  /** Timestamp for a local event. */
  now(): string {
    const pt = this.clock();
    if (pt > this.state.wall) this.state = { wall: pt, counter: 0 };
    else this.state = { wall: this.state.wall, counter: this.state.counter + 1 };
    return encodeHlc(this.state, this.node);
  }

  /** Merge a timestamp seen on a remote op so later local events sort after it. */
  observe(remote: string): void {
    const r = decodeHlc(remote);
    const pt = this.clock();
    const wall = Math.max(pt, this.state.wall, r.wall);
    let counter: number;
    if (wall === this.state.wall && wall === r.wall) counter = Math.max(this.state.counter, r.counter) + 1;
    else if (wall === this.state.wall) counter = this.state.counter + 1;
    else if (wall === r.wall) counter = r.counter + 1;
    else counter = 0;
    this.state = { wall, counter };
  }
}

export function encodeHlc(s: HlcState, node: string): string {
  return `${String(s.wall).padStart(13, '0')}-${String(s.counter).padStart(4, '0')}-${node}`;
}

export function decodeHlc(hlc: string): HlcState & { node: string } {
  const [wall, counter, ...node] = hlc.split('-');
  return { wall: Number(wall), counter: Number(counter), node: node.join('-') };
}

export function hlcTime(hlc: string): number {
  return decodeHlc(hlc).wall;
}
