import { CliError } from './util';

/** Tiny argv parser: `cmd --flag value --flag=value --bool positional`. */
export interface Args {
  command: string | null;
  positional: string[];
  flags: Record<string, string | true>;
}

/** Flags that never take a value. */
const BOOLEAN = new Set(['minify', 'help', 'h', 'json', 'no-open', 'verbose']);

export function parseArgs(argv: string[]): Args {
  const out: Args = { command: null, positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') { out.positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      const body = a.replace(/^--?/, '');
      const eq = body.indexOf('=');
      if (eq >= 0) { out.flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
      const next = argv[i + 1];
      if (!BOOLEAN.has(body) && next !== undefined && !next.startsWith('-')) { out.flags[body] = next; i++; }
      else out.flags[body] = true;
      continue;
    }
    if (out.command === null) out.command = a;
    else out.positional.push(a);
  }
  return out;
}

export function intFlag(args: Args, name: string, fallback: number, min: number, max: number): number {
  const v = args.flags[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new CliError(`--${name} must be a whole number from ${min} to ${max}`);
  return n;
}

export function strFlag(args: Args, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' ? v : undefined;
}
