// Guess the Flag: the rules as plain functions. logic/index.ts wires them into the game.
// First a lobby where anyone in the chat sets the game up (cards or typing, time, rounds, flags), then
// everyone sees the same flag at the same time. Faster right answers score more.
// Keep everything in `State`: same seed + same answers = same game.
import { ALL, FAMOUS, REGIONS, REGION_NAMES, regionOf, type Region } from './countries';

export type Phase = 'lobby' | 'question' | 'reveal' | 'done';
export type Pool = 'famous' | 'all' | Region;
export const POOLS: readonly Pool[] = ['famous', 'all', ...REGION_NAMES];
/** cards = pick one of four; text = type the country (any of all countries counts as an answer). */
export type AnswerMode = 'cards' | 'text';
export const ANSWER_MODES: readonly AnswerMode[] = ['cards', 'text'];

export const SECONDS = { min: 5, max: 60 } as const;
export const ROUNDS = { min: 3, max: 30 } as const;
export const REVEAL_MS = 3500;
export const BASE_POINTS = { cards: 100, text: 150 } as const; // typing is harder: more points
export const SPEED_POINTS = 100;
export const STREAK_POINTS = 20; // per right answer in a row after the first, up to +100
export const OPTIONS = 4;

export interface Settings {
  mode: AnswerMode;
  seconds: number;
  rounds: number;
  pool: Pool;
}

export interface Question {
  flag: string;
  /** Four countries in cards mode; empty in text mode. */
  options: string[];
}

export interface Answer {
  pick: string;
  /** ms after the flag appeared. */
  ms: number;
  points: number;
}

export interface State {
  phase: Phase;
  settings: Settings;
  /** Who last changed the settings (lobby). */
  changedBy: string | null;
  /** 0-based round. */
  round: number;
  /** ms left in this phase. */
  left: number;
  q: Question;
  answers: Record<string, Answer>;
  scores: Record<string, number>;
  streaks: Record<string, number>;
  right: Record<string, number>;
  /** Players who left for good: not waited for. */
  gone: string[];
  /** Flags already asked (no repeats in one game). */
  used: string[];
}

interface Rng { pick<T>(items: readonly T[]): T; shuffle<T>(items: readonly T[]): T[] }

const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

export function poolCodes(pool: Pool): readonly string[] {
  if (pool === 'famous') return FAMOUS;
  if (pool === 'all') return ALL;
  return REGIONS[pool];
}

/** Settings from start options (flags) or a player's change; anything invalid keeps `base`. */
export function readSettings(raw: unknown, base: Settings): Settings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    mode: (ANSWER_MODES as readonly unknown[]).includes(r.mode) ? (r.mode as AnswerMode) : base.mode,
    seconds: isInt(r.seconds, SECONDS.min, SECONDS.max) ? r.seconds : base.seconds,
    rounds: isInt(r.rounds, ROUNDS.min, ROUNDS.max) ? r.rounds : base.rounds,
    pool: (POOLS as readonly unknown[]).includes(r.pool) ? (r.pool as Pool) : base.pool,
  };
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({ mode: 'cards', seconds: 15, rounds: 10, pool: 'famous' });

/** A new flag from the pool; in cards mode plus three wrong answers, from the same continent when possible. */
export function newQuestion(settings: Settings, used: readonly string[], rng: Rng): Question {
  const pool = poolCodes(settings.pool);
  let fresh = pool.filter((c) => !used.includes(c));
  if (fresh.length === 0) fresh = [...pool];
  const flag = rng.pick(fresh);
  if (settings.mode === 'text') return { flag, options: [] };
  const region = regionOf(flag);
  const near: string[] = region ? REGIONS[region].filter((c) => c !== flag) : [];
  const far = ALL.filter((c) => c !== flag && !near.includes(c));
  const wrong = rng.shuffle(near).slice(0, OPTIONS - 1);
  if (wrong.length < OPTIONS - 1) wrong.push(...rng.shuffle(far).slice(0, OPTIONS - 1 - wrong.length));
  return { flag, options: rng.shuffle([flag, ...wrong]) };
}

/** `lobby: false` skips the lobby (the game was set up before it started). */
export function newState(ids: string[], settings: Settings, rng: Rng, lobby = true): State {
  const zero = () => Object.fromEntries(ids.map((id) => [id, 0]));
  const state: State = {
    phase: 'lobby', settings, changedBy: null, round: 0, left: 0,
    q: { flag: '', options: [] }, answers: {}, scores: zero(), streaks: zero(), right: zero(), gone: [], used: [],
  };
  if (!lobby) ask(state, rng);
  return state;
}

// ---------- lobby ----------

/** Any player may change the settings before the start. */
export function changeSettings(state: State, id: string, raw: unknown): void {
  if (state.phase !== 'lobby') throw new Error('already_started');
  if (!raw || typeof raw !== 'object') throw new Error('bad_settings');
  const next = readSettings(raw, state.settings);
  if (JSON.stringify(next) === JSON.stringify(state.settings)) throw new Error('bad_settings');
  state.settings = next;
  state.changedBy = id;
}

/** Any player may start. */
export function start(state: State, rng: Rng): void {
  if (state.phase !== 'lobby') throw new Error('already_started');
  ask(state, rng);
}

// ---------- the game ----------

function ask(state: State, rng: Rng): void {
  state.q = newQuestion(state.settings, state.used, rng);
  state.used.push(state.q.flag);
  state.answers = {};
  state.phase = 'question';
  state.left = state.settings.seconds * 1000;
}

/** Points for a right answer: 100 (150 typed), up to +100 for speed, +20 per answer in a row. */
export function points(mode: AnswerMode, ms: number, limit: number, streakBefore: number): number {
  const speed = Math.round(SPEED_POINTS * Math.max(0, 1 - ms / limit));
  return BASE_POINTS[mode] + speed + Math.min(5, streakBefore) * STREAK_POINTS;
}

/** Everyone still in the game has answered. */
export function allAnswered(state: State): boolean {
  return Object.keys(state.scores).every((id) => state.gone.includes(id) || state.answers[id]);
}

export function answer(state: State, id: string, pick: unknown): void {
  if (state.phase !== 'question') throw new Error('not_now');
  if (state.answers[id]) throw new Error('already_answered');
  const valid = state.settings.mode === 'cards' ? state.q.options : ALL;
  if (typeof pick !== 'string' || !valid.includes(pick)) throw new Error('bad_option');
  const limit = state.settings.seconds * 1000;
  const ms = limit - state.left;
  const pts = pick === state.q.flag ? points(state.settings.mode, ms, limit, state.streaks[id] ?? 0) : 0;
  state.answers[id] = { pick, ms, points: pts };
  if (allAnswered(state)) reveal(state);
}

/** Shows the answer and adds up the points. */
function reveal(state: State): void {
  for (const id of Object.keys(state.scores)) {
    const a = state.answers[id];
    if (a && a.pick === state.q.flag) {
      state.scores[id]! += a.points;
      state.streaks[id]! += 1;
      state.right[id]! += 1;
    } else {
      state.streaks[id] = 0;
    }
  }
  state.phase = 'reveal';
  state.left = REVEAL_MS;
}

export function step(state: State, dtMs: number, rng: Rng): void {
  if (state.phase === 'done' || state.phase === 'lobby') return;
  state.left = Math.max(0, state.left - Math.max(0, Math.min(dtMs, 1000)));
  if (state.left > 0) return;
  if (state.phase === 'question') return reveal(state);
  if (state.round + 1 >= state.settings.rounds) { state.phase = 'done'; return; }
  state.round++;
  ask(state, rng);
}

export function leave(state: State, id: string): void {
  if (!state.gone.includes(id)) state.gone.push(id);
  if (state.phase === 'question' && allAnswered(state)) reveal(state);
}

/** Places by score; equal scores share a place (1, 1, 3). */
export function placements(state: State): { userId: string; place: number; score: number }[] {
  const rows = Object.entries(state.scores).sort((a, b) => b[1] - a[1]);
  return rows.map(([userId, score]) => ({ userId, score, place: 1 + rows.filter(([, s]) => s > score).length }));
}

/**
 * What one player may see. The other players' picks stay on the server until the reveal,
 * so nobody can copy; you only see who has answered.
 */
export function viewFor(state: State, viewerId: string | null) {
  const open = state.phase === 'reveal' || state.phase === 'done';
  const mine = viewerId ? state.answers[viewerId] : undefined;
  return {
    phase: state.phase, settings: state.settings, changedBy: state.changedBy,
    round: state.round, left: state.left,
    flag: state.q.flag, options: state.q.options,
    answer: open ? state.q.flag : null,
    answered: Object.keys(state.answers),
    answers: open ? state.answers : mine && viewerId ? { [viewerId]: { pick: mine.pick, ms: mine.ms, points: 0 } } : {},
    scores: state.scores, streaks: state.streaks, right: state.right, gone: state.gone,
  };
}

export type View = ReturnType<typeof viewFor>;
