export interface Args {
  positional: string[];
  flags: Record<string, string | true>;
}

/** Minimal argv parser: `--key value`, `--key=value`, `--flag`, everything else positional. */
export function parseArgs(argv: string[], booleans: ReadonlySet<string> = new Set()): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      const name = a.slice(2, eq);
      if (booleans.has(name)) throw new Error(`--${name} does not take a value`);
      if (!a.slice(eq + 1)) throw new Error(`missing value for --${name}`);
      flags[name] = a.slice(eq + 1);
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (booleans.has(name)) flags[name] = true;
    else {
      if (next === undefined || next.startsWith('--')) throw new Error(`missing value for --${name}`);
      flags[name] = next;
      i++;
    }
  }
  return { positional, flags };
}

export function str(flags: Args['flags'], name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}
