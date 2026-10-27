/**
 * One isolated-vm Isolate per live session: its own heap (memory limit), no I/O,
 * no timers, no host objects. The host talks to it only through __vibesCall with
 * JSON strings, and every call has a CPU time limit.
 *
 * Isolates are created when a session wakes up and disposed when it sleeps or ends,
 * so memory follows the number of ACTIVE sessions, not open ones.
 */
import ivm from 'isolated-vm';
import { createHash } from 'crypto';
import { PRELUDE } from './prelude';
import type { Limits } from './limits';

export class SandboxError extends Error {
  constructor(message: string, readonly kind: 'crash' | 'timeout' | 'memory' | 'invalid') { super(message); }
}

export interface GameMeta {
  minPlayers: number;
  maxPlayers: number;
  tickHz: number;
  hasView: boolean;
  actions: string[];
  handlesLeave: boolean;
}

export interface CallOutput {
  rejected?: string;
  state?: unknown;
  rng?: number;
  over?: unknown;
  views?: Record<string, unknown> | null;
  turn?: { userId: string; seconds: number } | null;
  persisted?: { players: Record<string, unknown>; dm: unknown };
}

/** Compiled code cache per bundle hash: V8 can skip parsing when an isolate is recreated. */
const cachedData = new Map<string, ivm.ExternalCopy<ArrayBuffer>>();

export const sha256 = (code: string) => createHash('sha256').update(code, 'utf8').digest('hex');

export class Sandbox {
  private isolate: ivm.Isolate;
  private call!: ivm.Reference<(kind: string, input: string) => string>;
  /** CPU time of the last call (ms). */
  lastCpuMs = 0;

  private constructor(private readonly limits: Limits) {
    this.isolate = new ivm.Isolate({ memoryLimit: limits.memoryMb });
  }

  /** Creates the isolate, runs the prelude and the bundle. Throws SandboxError. */
  static async create(code: string, expectedSha256: string, limits: Limits): Promise<Sandbox> {
    const hash = sha256(code);
    if (hash !== expectedSha256) throw new SandboxError('logic bundle hash mismatch', 'invalid');
    const sb = new Sandbox(limits);
    try {
      const context = await sb.isolate.createContext();
      await context.eval(PRELUDE, { timeout: limits.hardCpuMs });
      const cache = cachedData.get(hash);
      const script = await sb.isolate.compileScript(code, {
        filename: `game-${hash.slice(0, 12)}.js`,
        ...(cache ? { cachedData: cache } : { produceCachedData: true }),
      });
      // compileScript returns the Script with CachedDataResult fields when asked to produce them.
      const produced = (script as ivm.Script & ivm.CachedDataResult).cachedData;
      if (!cache && produced) cachedData.set(hash, produced);
      // Loading the bundle gets a bigger budget than one action (top-level setup code).
      await script.run(context, { timeout: limits.hardCpuMs * 10 });
      script.release();
      sb.call = await context.global.get('__vibesCall', { reference: true });
      return sb;
    } catch (e) {
      // Classify before disposing: a disposed isolate would make every error look like "memory".
      const err = toSandboxError(e, sb.isolate);
      sb.dispose();
      throw err;
    }
  }

  async meta(): Promise<GameMeta> {
    const out = await this.run('meta', { rng: 0, persisted: { players: {}, dm: null } });
    return out as unknown as GameMeta;
  }

  /** Runs one call. Returns the parsed output; throws SandboxError on crash / limits. */
  async run(kind: string, input: Record<string, unknown>): Promise<CallOutput> {
    if (this.isolate.isDisposed) throw new SandboxError('sandbox disposed', 'memory');
    const before = cpu(this.isolate);
    try {
      const json = await this.call.apply(undefined, [kind, JSON.stringify(input)], {
        timeout: this.limits.hardCpuMs,
        arguments: { copy: true },
        result: { copy: true },
      });
      this.lastCpuMs = Number(cpu(this.isolate) - before) / 1e6;
      if (typeof json !== 'string') throw new SandboxError('logic returned no JSON', 'crash');
      if (json.length > this.limits.maxStateBytes * 4) throw new SandboxError('logic output too large', 'invalid');
      return JSON.parse(json) as CallOutput;
    } catch (e) {
      this.lastCpuMs = Number(cpu(this.isolate) - before) / 1e6;
      throw toSandboxError(e, this.isolate);
    }
  }

  dispose() {
    try { this.call?.release(); } catch { /* already gone */ }
    if (!this.isolate.isDisposed) this.isolate.dispose();
  }
}

/** cpuTime throws once the isolate is gone (e.g. killed for memory). */
function cpu(isolate: ivm.Isolate): bigint {
  try { return isolate.isDisposed ? 0n : isolate.cpuTime; } catch { return 0n; }
}

function toSandboxError(e: unknown, isolate: ivm.Isolate): SandboxError {
  if (e instanceof SandboxError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/timed out/i.test(msg)) return new SandboxError('logic took too long', 'timeout');
  if (isolate.isDisposed || /memory limit|disposed/i.test(msg)) return new SandboxError('logic ran out of memory', 'memory');
  // Keep the message short: it ends up in logs and the dev portal, never sent to players.
  return new SandboxError(msg.slice(0, 300), 'crash');
}
