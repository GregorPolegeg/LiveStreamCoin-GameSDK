// Texas Hold'em rules. Pure functions over State; the server is the only referee.
// Time comes from ctx.now (ms), randomness from ctx.rng: no Math.random or Date here.
import type { Rng } from '@vibes/games-logic';
import { best, cmp, fullDeck, handName, rankOf, type Score } from './cards';

export const CHIPS = [1000, 2500, 5000, 10000, 25000] as const;
export const BLINDS = [[5, 10], [10, 20], [25, 50], [50, 100], [100, 200]] as const;
export const BLINDS_UP = [0, 5, 10, 15] as const; // minutes, 0 = never
export const TIMERS = [15, 30, 60] as const; // seconds to act
export const REBUYS = ['none', 'once', 'any'] as const;
export const MAX_SEATS = 9;
export const BOT_NAMES = ['Maya', 'Eki', 'Luka', 'Nina', 'Drek', 'Ana', 'Tim', 'Zoe'] as const;

/** Pauses (ms) so people can see what happened. */
export const PAUSE = { street: 700, runout: 1100, showdown: 4200, fold: 2400, firstHand: 600 } as const;
/** How long a busted player may decide to rebuy before they are out. */
export const REBUY_MS = 30_000;

export type Rebuy = (typeof REBUYS)[number];
export interface Settings { chips: number; blinds: number; up: number; rebuy: Rebuy; timer: number; bots: number }
export const DEFAULT_SETTINGS: Settings = { chips: 5000, blinds: 2, up: 10, rebuy: 'once', timer: 30, bots: 3 };

export type Kind = 'fold' | 'check' | 'call' | 'raise';
export interface Seat {
  id: string;
  name: string;
  bot: boolean;
  stack: number;
  /** In front of the player this street. */
  bet: number;
  /** All chips put in this hand (for side pots). */
  committed: number;
  cards: string[];
  folded: boolean;
  allin: boolean;
  /** Not dealt in: busted, waiting to rebuy, or left. */
  out: boolean;
  acted: boolean;
  /** What the player did last, for the table ("Call 50", "Raise 200", "Fold", "+1,200"). */
  tag: string;
  tagKind: '' | 'fold' | 'allin' | 'win' | 'blind';
  /** Cards shown at the showdown. */
  show: boolean;
  rebuys: number;
  /** Busted and may rebuy until this time (ms); 0 = not waiting. */
  rebuyUntil: number;
  left: boolean;
  /** Hand number when this player busted for good (for places). */
  bustHand: number;
  timeouts: number;
}
export interface Win { seat: number; amount: number; hand: string }
export interface HandResult { hand: number; wins: Win[]; five: string[]; byFold: boolean }

export interface State {
  phase: 'lobby' | 'play' | 'done';
  host: string;
  settings: Settings;
  seats: Seat[];
  deck: string[];
  board: string[];
  /** 0 pre-flop, 1 flop, 2 turn, 3 river. */
  street: number;
  hand: number;
  dealer: number;
  /** Seat to act, -1 = nobody (dealing or between hands). */
  turn: number;
  /** Highest bet this street, and the smallest legal raise size. */
  bet: number;
  minRaise: number;
  /** Chips from finished streets (the bets in front of players are not in it yet). */
  pot: number;
  level: number;
  levelAt: number;
  /** When the player to act runs out of time. */
  deadline: number;
  /** When a bot to act moves. */
  botAt: number;
  /** What happens next on its own, and when. */
  pending: { what: 'hand' | 'street' | 'showdown'; at: number } | null;
  result: HandResult | null;
  /** Bumps on every change of turn (the client restarts the timer bar on it). */
  seq: number;
  endedBy: 'host' | 'winner' | 'nobody' | null;
}

const clampPick = <T>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);

export function readSettings(flags: Record<string, unknown>, base: Settings, humans: number): Settings {
  const maxBots = Math.max(0, MAX_SEATS - humans);
  const bots = Number.isInteger(flags.bots) ? Math.max(0, Math.min(maxBots, flags.bots as number)) : Math.min(maxBots, humans > 1 ? 0 : base.bots);
  return {
    chips: clampPick(flags.chips, CHIPS, base.chips),
    blinds: Number.isInteger(flags.blinds) && (flags.blinds as number) >= 0 && (flags.blinds as number) < BLINDS.length ? (flags.blinds as number) : base.blinds,
    up: clampPick(flags.up, BLINDS_UP, base.up),
    rebuy: clampPick(flags.rebuy, REBUYS, base.rebuy),
    timer: clampPick(flags.timer, TIMERS, base.timer),
    bots,
  };
}

const seat = (id: string, name: string, bot: boolean, chips: number): Seat => ({
  id, name, bot, stack: chips, bet: 0, committed: 0, cards: [], folded: false, allin: false, out: false, acted: false,
  tag: '', tagKind: '', show: false, rebuys: 0, rebuyUntil: 0, left: false, bustHand: 0, timeouts: 0,
});

export function newState(players: { userId: string; displayName?: string }[], settings: Settings): State {
  return {
    phase: 'lobby', host: players[0]?.userId ?? '', settings,
    seats: players.map((p) => seat(p.userId, p.displayName || 'Player', false, settings.chips)),
    deck: [], board: [], street: 0, hand: 0, dealer: -1, turn: -1, bet: 0, minRaise: 0, pot: 0,
    level: 0, levelAt: 0, deadline: 0, botAt: 0, pending: null, result: null, seq: 0, endedBy: null,
  };
}

export const blinds = (s: State): [number, number] => {
  const [sb, bb] = BLINDS[s.settings.blinds] ?? BLINDS[2];
  return [sb * 2 ** s.level, bb * 2 ** s.level];
};
const humans = (s: State) => s.seats.filter((p) => !p.bot);
const seatOf = (s: State, id: string) => s.seats.findIndex((p) => p.id === id && !p.bot);
export const inHand = (s: State) => s.seats.map((_, i) => i).filter((i) => !s.seats[i]!.out && !s.seats[i]!.folded);
export const canAct = (s: State) => inHand(s).filter((i) => !s.seats[i]!.allin);
/** The next seat after i that is dealt in. */
const nextIn = (s: State, i: number) => { let j = i; for (let k = 0; k < s.seats.length; k++) { j = (j + 1) % s.seats.length; if (!s.seats[j]!.out) return j; } return i; };
const nextActor = (s: State, i: number) => { let j = i; for (let k = 0; k < s.seats.length; k++) { j = (j + 1) % s.seats.length; const p = s.seats[j]!; if (!p.out && !p.folded && !p.allin) return j; } return -1; };
const fmt = (n: number) => n.toLocaleString('en');

// ---------- lobby ----------

export function changeSettings(s: State, by: string, change: unknown) {
  if (s.phase !== 'lobby') throw new Error('already_started');
  if (by !== s.host) throw new Error('not_host');
  if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('bad_settings');
  s.settings = readSettings({ ...s.settings, ...(change as Record<string, unknown>) }, s.settings, humans(s).length);
}

export function start(s: State, by: string | null, now: number, rng: Rng) {
  if (s.phase !== 'lobby') throw new Error('already_started');
  if (by !== null && by !== s.host) throw new Error('not_host');
  const people = humans(s).length;
  const bots = Math.min(MAX_SEATS - people, Math.max(s.settings.bots, people < 2 ? 1 : 0));
  const names = rng.shuffle(BOT_NAMES).slice(0, bots);
  names.forEach((n, k) => s.seats.push(seat(`bot:${k + 1}`, n, true, s.settings.chips)));
  // random seats, so the host is not always first
  s.seats = rng.shuffle(s.seats);
  for (const p of s.seats) p.stack = s.settings.chips;
  s.phase = 'play';
  s.dealer = rng.int(0, s.seats.length - 1);
  s.levelAt = now;
  s.pending = { what: 'hand', at: now + PAUSE.firstHand };
}

// ---------- a hand ----------

function post(s: State, i: number, amount: number, tag: string) {
  const p = s.seats[i]!;
  const a = Math.min(amount, p.stack);
  p.stack -= a; p.bet += a; p.committed += a;
  p.tag = tag; p.tagKind = 'blind';
  if (!p.stack) { p.allin = true; p.tag = 'All-in'; p.tagKind = 'allin'; }
}

function newHand(s: State, now: number, rng: Rng) {
  s.pending = null;
  if (s.settings.up && now - s.levelAt >= s.settings.up * 60_000) { s.level++; s.levelAt = now; }
  for (const p of s.seats) {
    Object.assign(p, { cards: [], bet: 0, committed: 0, folded: false, allin: false, acted: false, show: false, tag: '', tagKind: '' });
    p.out = p.stack <= 0 || p.left;
  }
  const dealt = s.seats.map((_, i) => i).filter((i) => !s.seats[i]!.out);
  if (dealt.length < 2) {
    // someone may still rebuy: wait for them, else the game is over
    if (s.seats.some((p) => p.rebuyUntil > now)) { s.pending = { what: 'hand', at: now + 1000 }; s.turn = -1; return; }
    return finishGame(s, 'winner');
  }
  s.hand++;
  s.result = null;
  s.board = [];
  s.street = 0;
  s.pot = 0;
  s.deck = rng.shuffle(fullDeck());
  s.dealer = nextIn(s, s.dealer < 0 ? 0 : s.dealer);
  const [sb, bb] = blinds(s);
  // heads-up: the dealer posts the small blind and acts first pre-flop
  const sbSeat = dealt.length === 2 ? s.dealer : nextIn(s, s.dealer);
  const bbSeat = nextIn(s, sbSeat);
  post(s, sbSeat, sb, 'SB');
  post(s, bbSeat, bb, 'BB');
  for (let r = 0; r < 2; r++) { let i = nextIn(s, s.dealer); for (let k = 0; k < dealt.length; k++) { s.seats[i]!.cards.push(s.deck.pop()!); i = nextIn(s, i); } }
  s.bet = bb;
  s.minRaise = bb;
  s.turn = -1;
  const first = nextActor(s, bbSeat);
  if (first < 0 || canAct(s).length < 2 && s.seats[first]!.bet >= s.bet) return endStreet(s, now);
  giveTurn(s, first, now, rng);
}

function giveTurn(s: State, i: number, now: number, rng: Rng) {
  s.turn = i;
  s.seq++;
  const p = s.seats[i]!;
  s.deadline = now + s.settings.timer * 1000;
  s.botAt = p.bot ? now + rng.int(700, 1700) : 0;
  // a player who left folds at once
  if (p.left) { s.deadline = now; }
}

export const toCall = (s: State, i: number) => Math.max(0, s.bet - s.seats[i]!.bet);
/** The smallest "raise to" for seat i (or all-in when that is less). */
export const minRaiseTo = (s: State, i: number) => Math.min(s.seats[i]!.bet + s.seats[i]!.stack, s.bet + s.minRaise);

/** A move by the seat to act. `to` is the total bet for a raise ("raise to"). */
export function act(s: State, i: number, kind: unknown, to: unknown, now: number, rng: Rng, auto = false) {
  if (s.phase !== 'play' || s.pending) throw new Error('not_now');
  if (i !== s.turn) throw new Error('not_your_turn');
  const p = s.seats[i]!;
  const call = Math.min(toCall(s, i), p.stack);
  switch (kind) {
    case 'fold':
      p.folded = true; p.tag = 'Fold'; p.tagKind = 'fold';
      break;
    case 'check':
      if (call > 0) throw new Error('cannot_check');
      p.tag = 'Check'; p.tagKind = '';
      break;
    case 'call':
      if (call <= 0) throw new Error('nothing_to_call');
      p.stack -= call; p.bet += call; p.committed += call;
      p.tag = `Call ${fmt(call)}`; p.tagKind = '';
      break;
    case 'raise': {
      if (typeof to !== 'number' || !Number.isInteger(to)) throw new Error('bad_amount');
      const max = p.bet + p.stack;
      if (max <= s.bet) throw new Error('cannot_raise');
      if (to > max) throw new Error('not_enough_chips');
      if (to < minRaiseTo(s, i)) throw new Error('raise_too_small');
      const word = s.street === 0 || s.bet > 0 ? 'Raise' : 'Bet';
      const add = to - p.bet;
      p.stack -= add; p.bet = to; p.committed += add;
      // a full raise reopens the betting for everyone
      if (to - s.bet >= s.minRaise) { s.minRaise = to - s.bet; for (const q of s.seats) q.acted = false; }
      s.bet = to;
      p.tag = `${word} ${fmt(to)}`; p.tagKind = '';
      break;
    }
    default:
      throw new Error('bad_move');
  }
  if (!p.stack && !p.folded) { p.allin = true; p.tag = 'All-in'; p.tagKind = 'allin'; }
  p.acted = true;
  if (!auto) p.timeouts = 0;
  advance(s, i, now, rng);
}

function roundDone(s: State) {
  const live = canAct(s);
  if (!live.length) return true;
  // the others are all-in: done once this one has matched the bet
  if (live.length === 1 && inHand(s).length > 1) return s.seats[live[0]!]!.bet >= s.bet;
  return live.every((i) => s.seats[i]!.acted && s.seats[i]!.bet === s.bet);
}

function advance(s: State, from: number, now: number, rng: Rng) {
  if (inHand(s).length === 1) return winByFold(s, now);
  if (roundDone(s)) return endStreet(s, now);
  const n = nextActor(s, from);
  if (n < 0) return endStreet(s, now);
  giveTurn(s, n, now, rng);
}

function collect(s: State) {
  for (const p of s.seats) { s.pot += p.bet; p.bet = 0; p.acted = false; if (!p.folded && !p.allin && p.tagKind !== 'win') { p.tag = ''; p.tagKind = ''; } }
  s.bet = 0;
}

function endStreet(s: State, now: number) {
  collect(s);
  s.turn = -1;
  s.seq++;
  if (s.street >= 3) { s.pending = { what: 'showdown', at: now + PAUSE.street }; return; }
  // everyone left is all-in: run the board out slowly
  s.pending = { what: 'street', at: now + (canAct(s).length <= 1 ? PAUSE.runout : PAUSE.street) };
}

function dealStreet(s: State, now: number, rng: Rng) {
  s.pending = null;
  s.street++;
  s.deck.pop(); // burn
  for (let k = s.street === 1 ? 3 : 1; k > 0; k--) s.board.push(s.deck.pop()!);
  s.minRaise = blinds(s)[1];
  if (canAct(s).length <= 1) { endStreet(s, now); if (canAct(s).length <= 1) for (const i of inHand(s)) s.seats[i]!.show = true; return; }
  giveTurn(s, nextActor(s, s.dealer), now, rng);
}

function winByFold(s: State, now: number) {
  collect(s);
  const w = inHand(s)[0]!;
  const p = s.seats[w]!;
  const amount = s.pot;
  p.stack += amount; p.tag = `+${fmt(amount)}`; p.tagKind = 'win';
  s.result = { hand: s.hand, wins: [{ seat: w, amount, hand: '' }], five: [], byFold: true };
  for (const q of s.seats) q.committed = 0;
  s.pot = 0; s.turn = -1; s.seq++;
  s.pending = { what: 'hand', at: now + PAUSE.fold };
}

/** Side pots from what everyone put in, paid to the best hand that may win each one. */
export function settle(s: State): Win[] {
  const total = s.seats.reduce((n, p) => n + p.committed, 0);
  const live = inHand(s);
  const scores = new Map<number, { score: Score; five: string[] }>(live.map((i) => [i, best([...s.seats[i]!.cards, ...s.board])]));
  const levels = [...new Set(live.map((i) => s.seats[i]!.committed))].sort((a, b) => a - b);
  const paid = new Map<number, number>();
  let prev = 0, given = 0, lastWinners: number[] = [];
  for (const level of levels) {
    const pot = s.seats.reduce((n, p) => n + Math.min(p.committed, level) - Math.min(p.committed, prev), 0);
    const can = live.filter((i) => s.seats[i]!.committed >= level);
    let top: number[] = [];
    for (const i of can) {
      if (!top.length) { top = [i]; continue; }
      const c = cmp(scores.get(i)!.score, scores.get(top[0]!)!.score);
      if (c > 0) top = [i]; else if (c === 0) top.push(i);
    }
    split(s, top, pot, paid);
    given += pot; prev = level; lastWinners = top;
  }
  // chips from folded players above the last level
  if (total > given) split(s, lastWinners, total - given, paid);
  return [...paid].map(([seat, amount]) => ({ seat, amount, hand: handName(scores.get(seat)!.score) }));
}

/** Split a pot; the odd chips go to the first winners left of the dealer. */
function split(s: State, winners: number[], pot: number, paid: Map<number, number>) {
  if (!winners.length || pot <= 0) return;
  const order = [...winners].sort((a, b) => ((a - s.dealer - 1 + s.seats.length) % s.seats.length) - ((b - s.dealer - 1 + s.seats.length) % s.seats.length));
  const share = Math.floor(pot / order.length);
  let odd = pot - share * order.length;
  for (const w of order) { const a = share + (odd-- > 0 ? 1 : 0); paid.set(w, (paid.get(w) ?? 0) + a); }
}

function showdown(s: State, now: number) {
  s.pending = null;
  // the river can be reached with cards still to come only when the board ran out; deal them
  while (s.board.length < 5) { s.deck.pop(); s.board.push(s.deck.pop()!); }
  const live = inHand(s);
  for (const i of live) s.seats[i]!.show = true;
  const wins = settle(s);
  for (const w of wins) { const p = s.seats[w.seat]!; p.stack += w.amount; p.tag = `+${fmt(w.amount)}`; p.tagKind = 'win'; }
  const topSeat = wins.slice().sort((a, b) => b.amount - a.amount)[0]!.seat;
  s.result = { hand: s.hand, wins, five: best([...s.seats[topSeat]!.cards, ...s.board]).five, byFold: false };
  for (const q of s.seats) q.committed = 0;
  s.pot = 0; s.turn = -1; s.seq++;
  s.pending = { what: 'hand', at: now + PAUSE.showdown };
}

// ---------- between hands: busts, rebuys, the end ----------

export const mayRebuy = (s: State, p: Seat) => s.settings.rebuy === 'any' || (s.settings.rebuy === 'once' && p.rebuys < 1 && s.level < 2);

function afterHand(s: State, now: number, rng: Rng) {
  for (const p of s.seats) {
    if (p.stack > 0 || p.bustHand) continue;
    if (p.bot && !p.left && mayRebuy(s, p)) { p.stack = s.settings.chips; p.rebuys++; p.tag = 'Rebuy'; p.tagKind = ''; continue; }
    if (!p.bot && !p.left && mayRebuy(s, p)) { if (!p.rebuyUntil) p.rebuyUntil = now + REBUY_MS; p.out = true; continue; }
    if (!p.bustHand) p.bustHand = s.hand;
    p.out = true;
  }
  // nobody real at the table any more
  const people = s.seats.filter((p) => !p.bot && !p.left && (p.stack > 0 || p.rebuyUntil > now));
  if (!people.length) return finishGame(s, 'nobody');
  newHand(s, now, rng);
}

export function rebuy(s: State, id: string, now: number) {
  const i = seatOf(s, id);
  const p = s.seats[i];
  if (s.phase !== 'play' || !p || p.stack > 0 || p.rebuyUntil <= now) throw new Error('not_now');
  if (!mayRebuy(s, p)) throw new Error('no_rebuys_left');
  p.stack = s.settings.chips; p.rebuys++; p.rebuyUntil = 0; p.tag = 'Rebuy'; p.tagKind = '';
  // back in at the next hand
}

export function sitOut(s: State, id: string) {
  const p = s.seats[seatOf(s, id)];
  if (s.phase !== 'play' || !p || p.stack > 0 || !p.rebuyUntil) throw new Error('not_now');
  p.rebuyUntil = 0; p.bustHand = s.hand; p.out = true;
}

export function leave(s: State, id: string, now: number, rng: Rng) {
  const i = seatOf(s, id);
  const p = s.seats[i];
  if (!p || p.left) return;
  p.left = true;
  p.rebuyUntil = 0;
  if (!p.bustHand) p.bustHand = s.hand;
  if (s.phase !== 'play') return;
  if (s.turn === i && !s.pending) return act(s, i, 'fold', null, now, rng, true);
  if (!p.folded && !p.out) { p.folded = true; p.tag = 'Left'; p.tagKind = 'fold'; if (inHand(s).length === 1 && !s.pending) winByFold(s, now); }
}

export function endGame(s: State, by: string) {
  if (by !== s.host) throw new Error('not_host');
  if (s.phase === 'done') throw new Error('not_now');
  // chips in the middle go back to who put them in
  for (const p of s.seats) { p.stack += p.committed; p.committed = 0; p.bet = 0; }
  s.pot = 0;
  finishGame(s, 'host');
}

function finishGame(s: State, by: 'host' | 'winner' | 'nobody') {
  s.phase = 'done';
  s.turn = -1;
  s.pending = null;
  s.endedBy = by;
  s.seq++;
}

/** Places for real players: chips left first, then who busted later. */
export function placements(s: State): { userId: string; place: number; score: number }[] {
  const people = s.seats.filter((p) => !p.bot);
  const key = (p: Seat) => (p.stack > 0 && !p.left ? 1e12 + p.stack : p.bustHand);
  const sorted = [...people].sort((a, b) => key(b) - key(a));
  let place = 0, lastKey = NaN;
  return sorted.map((p, k) => { const kk = key(p); if (kk !== lastKey) { place = k + 1; lastKey = kk; } return { userId: p.id, place, score: p.stack }; });
}

// ---------- the clock (update) ----------

export function step(s: State, now: number, rng: Rng) {
  if (s.phase !== 'play') return;
  for (const p of s.seats) if (p.rebuyUntil && p.rebuyUntil <= now && p.stack <= 0) { p.rebuyUntil = 0; if (!p.bustHand) p.bustHand = s.hand; }
  if (s.pending) {
    if (now < s.pending.at) return;
    const what = s.pending.what;
    if (what === 'hand') return afterHand(s, now, rng);
    if (what === 'street') return dealStreet(s, now, rng);
    return showdown(s, now);
  }
  if (s.turn < 0) return;
  const p = s.seats[s.turn]!;
  if (p.bot && now >= s.botAt) return act(s, s.turn, ...botMove(s, s.turn, rng), now, rng);
  if (now >= s.deadline) {
    if (!p.bot && !p.left) p.timeouts++;
    return act(s, s.turn, toCall(s, s.turn) ? 'fold' : 'check', null, now, rng, true);
  }
}

// ---------- bots ----------

function botMove(s: State, i: number, rng: Rng): [Kind, number | null] {
  const p = s.seats[i]!;
  const cards = [...p.cards, ...s.board];
  let strength: number;
  if (cards.length >= 5) strength = best(cards).score[0]! / 4 + rng.next() * 0.3;
  else {
    const [a, b] = p.cards.map(rankOf) as [number, number];
    strength = (a === b ? 0.55 : 0) + (Math.max(a, b) / 14) * 0.45 + (p.cards[0]![1] === p.cards[1]![1] ? 0.08 : 0) + rng.next() * 0.25;
  }
  const call = toCall(s, i);
  const bb = blinds(s)[1];
  const max = p.bet + p.stack;
  const raise = (to: number): [Kind, number | null] => {
    const t = Math.max(minRaiseTo(s, i), Math.min(max, to));
    return max > s.bet ? ['raise', t] : [call ? 'call' : 'check', null];
  };
  const pot = s.pot + s.seats.reduce((n, q) => n + q.bet, 0);
  if (call === 0) return strength > 0.8 && rng.next() < 0.5 ? raise(s.bet + Math.max(s.minRaise, Math.round((pot * 0.5) / bb) * bb)) : ['check', null];
  if (strength < 0.35 && call > bb) return ['fold', null];
  if (strength > 0.85 && rng.next() < 0.4) return raise(s.bet + s.minRaise * 2);
  if (call >= p.stack && strength < 0.6) return ['fold', null];
  return ['call', null];
}

// ---------- what each player sees ----------

export interface SeatView extends Omit<Seat, 'cards'> { cards: (string | null)[]; me: boolean }
export interface View extends Omit<State, 'deck' | 'seats'> {
  seats: SeatView[];
  /** My seat index, -1 for spectators. */
  you: number;
  blindsNow: [number, number];
}

export function viewFor(s: State, viewer: string | null): View {
  const { deck: _deck, seats, ...rest } = s;
  const you = viewer ? seats.findIndex((p) => p.id === viewer && !p.bot) : -1;
  return {
    ...rest,
    you,
    blindsNow: blinds(s),
    seats: seats.map((p, i) => ({ ...p, me: i === you, cards: i === you || p.show ? p.cards : p.cards.map(() => null) })),
  };
}
