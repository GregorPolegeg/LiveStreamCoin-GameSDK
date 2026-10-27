/**
 * Fuzz bots for `vibes-games check` (spec §9.1, checks 4-6).
 *
 * Every fuzz game is played twice with the same seed and the same bot moves:
 *   run 1: a fresh Sandbox for the whole game (like a session that never sleeps);
 *   run 2: ONE sandbox kept warm across all games, and in each game the session is
 *          "restarted" into a fresh sandbox at some step (like a session that sleeps
 *          and wakes on another worker).
 * Logic that keeps state outside `state` (module-level counters, caches that change
 * results, …) gives different outputs in the two runs, and that is reported.
 */
import { Sandbox, SandboxError, normalizeResult, seedToUint32, sha256, type GameMeta, type Limits, type Player } from '@vibes/game-runtime';
import type { Manifest } from './manifest';

export const PLAYER_NAMES = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy', 'kim', 'leo', 'mia', 'nick', 'olga', 'pete'];

/**
 * Appended to the bundle for fuzzing only. Observes, never changes results: records
 * calls to banned APIs (even when the game catches the error) and actions that throw
 * something that is not a reject code (players would only see "rejected").
 */
const PROBE = String.raw`
;(function () {
  var call = globalThis.__vibesCall, g = globalThis.__vibesGame, notes = [];
  var CODE = /^[a-z0-9_]{1,64}$/;
  var note = function (m) { m = String(m).slice(0, 240); if (notes.length < 5 && notes.indexOf(m) < 0) notes.push(m); };
  var R = Math.random;
  Math.random = function () { note('Math.random is not allowed in game logic (use ctx.rng / ctx.now)'); return R.apply(this, arguments); };
  var D = globalThis.Date;
  var W = function () { note('Date is not allowed in game logic (use ctx.rng / ctx.now)'); return D.apply(this, arguments); };
  W.now = function () { note('Date.now is not allowed in game logic (use ctx.rng / ctx.now)'); return D.now(); };
  globalThis.Date = W;
  try {
    if (g && g.actions && typeof g.actions === 'object') Object.keys(g.actions).forEach(function (k) {
      var f = g.actions[k];
      if (typeof f !== 'function') return;
      g.actions[k] = function (s, p, c) {
        try { return f.call(this, s, p, c); } catch (e) {
          var m = e && typeof e.message === 'string' ? e.message : String(e);
          if (/is not allowed in game logic/.test(m)) note(m);
          else if (!CODE.test(m)) note('action "' + k + '" threw ' + (e && e.name ? e.name + ': ' : '') + m);
          throw e;
        }
      };
    });
  } catch (e) { /* frozen actions: no action probe */ }
  globalThis.__vibesCall = function (kind, input) {
    notes = [];
    var out = call(kind, input);
    if (!notes.length) return out;
    var o = JSON.parse(out); o.__notes = notes; return JSON.stringify(o);
  };
})();
`;

export interface Crash { seed: string; step: number; call: string; by?: string; payload?: unknown; kind: string; message: string }
export interface Note { message: string; count: number; seed: string; step: number; call: string; payload?: unknown }

export interface FuzzResult {
  games: number;
  ended: number;
  unfinished: number;
  calls: number;
  rejected: number;
  accepted: number;
  crashes: Crash[];
  notes: Map<string, Note>;
  invalidResults: { seed: string; over: unknown }[];
  noState: string[];
  divergence: null | { seed: string; step: number; call: string; path: string; run1: string; run2: string };
  cpuMs: number[];
  maxStateBytes: number;
  maxStateSeed: string;
  turnSeconds: Set<number>;
}

/** Same PRNG as the sandbox (mulberry32), for the bots' own choices. */
function botRng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(a: readonly T[]): T => a[int(0, a.length - 1)]!;
  return { next, int, pick };
}
type Bot = ReturnType<typeof botRng>;

const STRINGS = ['', 'a', 'x', 'up', 'left', '0', '1', 'red', 'A'.repeat(40)];
const KEYS = ['x', 'y', 'cell', 'id', 'value', 'i', 'to', 'from', 'card', 'dir', 'amount'];
const ODD_NUMBERS = [1e9, -1e9, 0.5, -0.25, 2 ** 31, Number.MAX_SAFE_INTEGER];

/** Small "valid-looking" payloads: ints -5..20, strings, null, booleans, arrays / objects of those. */
export function payload(bot: Bot, depth = 0): unknown {
  const r = bot.next();
  if (r < 0.45) return bot.int(-5, 20);
  if (r < 0.5) return bot.pick(ODD_NUMBERS);
  if (r < 0.62) return bot.pick(STRINGS);
  if (r < 0.68) return null;
  if (r < 0.76) return bot.next() < 0.5;
  if (depth >= 2) return bot.int(-5, 20);
  if (r < 0.88) return Array.from({ length: bot.int(0, 3) }, () => payload(bot, depth + 1));
  const o: Record<string, unknown> = {};
  for (let i = bot.int(1, 3); i > 0; i--) o[bot.pick(KEYS)] = payload(bot, depth + 1);
  return o;
}

const T0 = 1_767_225_600_000; // fixed fake clock (2026-01-01) so runs are comparable

export async function fuzz(opts: { code: string; meta: GameMeta; manifest: Manifest; games: number; steps: number; limits: Limits }): Promise<FuzzResult> {
  const code = opts.code + '\n' + PROBE;
  const hash = sha256(code);
  const create = () => Sandbox.create(code, hash, opts.limits);
  const res: FuzzResult = {
    games: 0, ended: 0, unfinished: 0, calls: 0, rejected: 0, accepted: 0, crashes: [], notes: new Map(),
    invalidResults: [], noState: [], divergence: null, cpuMs: [], maxStateBytes: 0, maxStateSeed: '', turnSeconds: new Set(),
  };
  const { min, max } = { min: Math.max(1, opts.meta.minPlayers || opts.manifest.players.min), max: Math.max(1, opts.meta.maxPlayers || opts.manifest.players.max) };
  let warm: Sandbox | null = null;

  try {
    for (let g = 0; g < opts.games; g++) {
      const seed = `fuzz-${g}`;
      const n = min + (g % (max - min + 1));
      const mode = opts.manifest.modes[g % opts.manifest.modes.length]!;

      // Run 1: fresh sandbox.
      const fresh = await create();
      const run1 = await play({ seed, n, mode, steps: opts.steps, meta: opts.meta, res, record: true, sandbox: () => fresh, restartAt: -1, create });
      fresh.dispose();

      // Run 2: warm sandbox from earlier games, restarted into a fresh one mid-game.
      if (!warm) warm = await create();
      const restartAt = 1 + (seedToUint32('restart:' + seed) % 12);
      let current: Sandbox = warm;
      let temp: Sandbox | null = null;
      const run2 = await play({
        seed, n, mode, steps: opts.steps, meta: opts.meta, res, record: false, restartAt, create,
        sandbox: () => current,
        restart: (sb) => { temp = sb; current = sb; },
      });
      (temp as Sandbox | null)?.dispose();
      if (run2.brokeWarm) { warm.dispose(); warm = null; }

      res.games++;
      if (!res.divergence) {
        const len = Math.max(run1.trace.length, run2.trace.length);
        for (let i = 0; i < len; i++) {
          if (run1.trace[i] === run2.trace[i]) continue;
          const a = run1.trace[i] ?? '(game already over)';
          const b = run2.trace[i] ?? '(game already over)';
          res.divergence = { seed, step: i, call: run1.calls[i] ?? run2.calls[i] ?? '?', path: diffPath(a, b), run1: a, run2: b };
          break;
        }
      }
    }
  } finally {
    warm?.dispose();
  }
  return res;
}

interface PlayOpts {
  seed: string; n: number; mode: string; steps: number; meta: GameMeta; res: FuzzResult; record: boolean;
  sandbox(): Sandbox; restartAt: number; create(): Promise<Sandbox>; restart?(sb: Sandbox): void;
}

async function play(o: PlayOpts): Promise<{ trace: string[]; calls: string[]; brokeWarm: boolean }> {
  const { seed, res, record } = o;
  const players: Player[] = PLAYER_NAMES.slice(0, o.n).map((userId, seat) => ({ userId, seat, displayName: userId[0]!.toUpperCase() + userId.slice(1) }));
  const pub = players.map((p) => ({ userId: p.userId, seat: p.seat, displayName: p.displayName, avatarUrl: null }));
  const bot = botRng(seedToUint32('bot:' + seed));
  let state: unknown = null;
  let rng = seedToUint32(seed);
  let persisted: { players: Record<string, unknown>; dm: unknown } = { players: Object.fromEntries(players.map((p) => [p.userId, {}])), dm: {} };
  let turn: { userId: string; seconds: number } | null = null;
  const active = players.map((p) => p.userId);
  let leftDone = false;
  const trace: string[] = [];
  const calls: string[] = [];
  let brokeWarm = false;

  /** One sandbox call. Returns the output, or null when the game must stop (crash). */
  const call = async (step: number, kind: string, label: string, extra: Record<string, unknown>, by?: string) => {
    calls.push(label);
    const sb = o.sandbox();
    try {
      const out = await sb.run(kind, {
        state, rng, persisted, now: T0 + step * 1000, mode: o.mode, flags: {}, viewers: players.map((p) => p.userId), ...extra,
      }) as Record<string, unknown>;
      if (record) { res.calls++; res.cpuMs.push(sb.lastCpuMs); }
      const notes = out.__notes as string[] | undefined;
      if (notes && record) {
        for (const m of notes) {
          const key = m.replace(/\d+/g, '#');
          const hit = res.notes.get(key);
          if (hit) hit.count++;
          else res.notes.set(key, { message: m, count: 1, seed, step, call: label, payload: extra.payload });
        }
      }
      trace.push(JSON.stringify(out));
      return out;
    } catch (e) {
      const err = e instanceof SandboxError ? e : new SandboxError(String(e), 'crash');
      trace.push(`CRASH ${err.kind}: ${err.message}`);
      if (err.kind === 'memory' || err.kind === 'timeout') brokeWarm = true;
      if (record && res.crashes.length < 50) res.crashes.push({ seed, step, call: label, by, payload: extra.payload, kind: err.kind, message: err.message });
      return null;
    }
  };

  /** Takes an accepted output; true when the game is over. */
  const apply = (out: Record<string, unknown>): boolean => {
    if (out.state !== undefined) state = out.state;
    if (typeof out.rng === 'number') rng = out.rng >>> 0;
    if (out.persisted) persisted = out.persisted as typeof persisted;
    turn = (out.turn as typeof turn) ?? null;
    if (record) {
      if (turn && typeof turn.seconds === 'number') res.turnSeconds.add(turn.seconds);
      const bytes = Buffer.byteLength(JSON.stringify(state ?? null), 'utf8');
      if (bytes > res.maxStateBytes) { res.maxStateBytes = bytes; res.maxStateSeed = seed; }
    }
    if (out.over) {
      if (record && !normalizeResult(out.over, players)) res.invalidResults.push({ seed, over: out.over });
      return true;
    }
    return false;
  };

  const setup = await call(0, 'setup', 'setup', { players: pub });
  if (!setup) return { trace, calls, brokeWarm };
  if (setup.state === undefined || setup.state === null) {
    if (record) res.noState.push(seed);
  }
  if (apply(setup)) { if (record) res.ended++; return { trace, calls, brokeWarm }; }

  for (let step = 1; step <= o.steps; step++) {
    if (step === o.restartAt && o.restart) o.restart(await o.create());
    const r = bot.next();
    let out: Record<string, unknown> | null;
    if (turn && r < 0.08) {
      const t = turn as { userId: string };
      out = await call(step, 'timeout', `turnTimer.onTimeout(${t.userId})`, { playerId: t.userId });
    } else if (o.meta.tickHz > 0 && r < 0.25) {
      const dt = Math.round(1000 / Math.min(o.meta.tickHz, 30));
      out = await call(step, 'tick', `update(dt=${dt})`, { dt });
    } else if (o.meta.handlesLeave && !leftDone && active.length > 1 && r > 0.995) {
      leftDone = true;
      const userId = active.splice(bot.int(0, active.length - 1), 1)[0]!;
      const reason = bot.next() < 0.5 ? 'timeout' : 'quit';
      out = await call(step, 'left', `events.playerLeft(${userId}, ${reason})`, { player: pub.find((p) => p.userId === userId), reason });
    } else {
      const by = bot.pick(active);
      const name = bot.pick(o.meta.actions);
      const p = payload(bot);
      out = await call(step, 'action', `${name}(${JSON.stringify(p)}) by ${by}`, { name, payload: p, playerId: by }, by);
    }
    if (!out) return { trace, calls, brokeWarm };
    if (out.rejected) { if (record) res.rejected++; continue; }
    if (record) res.accepted++;
    if (apply(out)) { if (record) res.ended++; return { trace, calls, brokeWarm }; }
  }
  if (record) res.unfinished++;
  return { trace, calls, brokeWarm };
}

/** First JSON path where two outputs differ, e.g. "state.board[3]". */
export function diffPath(a: string, b: string): string {
  let x: unknown, y: unknown;
  try { x = JSON.parse(a); y = JSON.parse(b); } catch { return '(output)'; }
  const walk = (p: unknown, q: unknown, path: string): string | null => {
    if (JSON.stringify(p) === JSON.stringify(q)) return null;
    if (p && q && typeof p === 'object' && typeof q === 'object' && Array.isArray(p) === Array.isArray(q)) {
      const keys = new Set([...Object.keys(p as object), ...Object.keys(q as object)]);
      for (const k of keys) {
        const sub = Array.isArray(p) ? `${path}[${k}]` : path ? `${path}.${k}` : k;
        const hit = walk((p as Record<string, unknown>)[k], (q as Record<string, unknown>)[k], sub);
        if (hit) return hit;
      }
    }
    return path || '(output)';
  };
  return walk(x, y, '') ?? '(output)';
}
