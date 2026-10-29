// Unit tests for the rules: call the logic directly with a fake ctx. Run with `npm test`.
// `npm run check` then plays hundreds of random games in the real sandbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ctx, Rng } from '@vibes/games-logic';
import game, { type State } from '../logic';
import { best, cmp, handName } from '../logic/cards';
import { blinds, inHand, placements, settle, step, toCall, viewFor } from '../logic/rules';

function fakeRng(seed = 1): Rng {
  let s = seed >>> 0;
  const next = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return {
    next, int,
    pick: <T>(items: readonly T[]) => items[int(0, items.length - 1)]!,
    shuffle: <T>(items: readonly T[]) => { const a = [...items]; for (let i = a.length - 1; i > 0; i--) { const j = int(0, i); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; },
  };
}

let now = 0;
const rng = fakeRng(7);
const ctx = (flags: Record<string, unknown> = {}): Ctx => ({ rng, now, mode: 'friendly', flags, persisted: {}, dm: { persisted: {} } });
const setup = (ids: string[], flags: Record<string, unknown> = {}) => game.setup({ ...ctx(flags), players: ids.map((userId, seat) => ({ userId, seat, displayName: userId })) });
const call = (s: State, name: string, payload: unknown, id: string) => (game.actions as any)[name](s, payload, { ...ctx(), playerId: id });
const move = (s: State, id: string, kind: string, to?: number) => call(s, 'move', { kind, to }, id);
/** Runs the clock until `until` is true (or a lot of time passed). */
const run = (s: State, until: (s: State) => boolean, maxMs = 60 * 60_000) => {
  for (let t = 0; t < maxMs && !until(s); t += 250) { now += 250; step(s, now, rng); }
};
const total = (s: State) => s.seats.reduce((n, p) => n + p.stack + p.committed, 0) - 0;
const turnId = (s: State) => s.seats[s.turn]?.id;

test('hand ranking: categories, wheel, kickers, best five of seven', () => {
  const sc = (c: string) => best(c.split(' ')).score;
  assert.equal(handName(sc('Ah Kh Qh Jh Th 2c 3d')), 'Straight flush');
  assert.equal(handName(sc('Ah 2d 3c 4s 5h Kd Kc')), 'Straight');
  assert.deepEqual(sc('Ah 2d 3c 4s 5h 9d 9c').slice(0, 2), [4, 5], 'the wheel is a 5-high straight');
  assert.equal(handName(sc('Kh Kd Kc 7s 7h 2c 3d')), 'Full house');
  assert.equal(handName(sc('2h 3h 9h Jh Kh Kd Kc')), 'Flush');
  assert.ok(cmp(sc('Ah Ad Kc 7s 4h 2c 3d'), sc('Ah Ad Qc 7s 4h 2c 3d')) > 0, 'kicker decides');
  assert.equal(cmp(sc('Ah Kd Qc Js 9h 2c 3d'), sc('As Kc Qd Jh 9s 2d 3c')), 0, 'same hand, other suits: a tie');
});

test('lobby: only the host changes settings and starts; options are clamped', () => {
  const s = setup(['host', 'guest']);
  assert.equal(s.phase, 'lobby');
  assert.throws(() => call(s, 'settings', { chips: 1000 }, 'guest'), /not_host/);
  call(s, 'settings', { chips: 1000, blinds: 9, timer: 15, bots: 99, rebuy: 'any' }, 'host');
  assert.equal(s.settings.chips, 1000);
  assert.equal(s.settings.blinds, 2, 'bad blinds index keeps the old one');
  assert.equal(s.settings.bots, 7, 'bots fill the free seats at most');
  assert.throws(() => call(s, 'start', null, 'guest'), /not_host/);
  call(s, 'start', null, 'host');
  assert.equal(s.seats.length, 9);
  assert.ok(s.seats.every((p) => p.stack === 1000));
  assert.throws(() => call(s, 'settings', { chips: 5000 }, 'host'), /already_started/);
});

test('one person alone gets at least one bot', () => {
  const s = setup(['solo'], { bots: 0, lobby: false });
  assert.equal(s.seats.length, 2);
  assert.ok(s.seats.some((p) => p.bot));
});

test('heads-up: the dealer posts the small blind and acts first; the big blind gets the option', () => {
  const s = setup(['a', 'b'], { bots: 0, lobby: false, blinds: 0 });
  run(s, (x) => x.turn >= 0);
  const d = s.seats[s.dealer]!;
  assert.equal(d.bet, blinds(s)[0], 'dealer = small blind');
  assert.equal(s.turn, s.dealer, 'dealer acts first pre-flop');
  move(s, d.id, 'call');
  const bb = s.seats.find((p) => p !== d)!;
  assert.equal(turnId(s), bb.id, 'the big blind may still raise');
  assert.throws(() => move(s, bb.id, 'call'), /nothing_to_call/);
  move(s, bb.id, 'check');
  run(s, (x) => x.street === 1 && x.turn >= 0);
  assert.equal(s.board.length, 3);
  assert.equal(turnId(s), bb.id, 'after the flop the big blind acts first');
});

test('moves: out of turn, too small raises and bad amounts say no; a raise reopens the betting', () => {
  const s = setup(['a', 'b', 'c'], { bots: 0, lobby: false });
  run(s, (x) => x.turn >= 0);
  const first = turnId(s)!;
  const other = s.seats.find((p) => p.id !== first)!.id;
  assert.throws(() => move(s, other, 'call'), /not_your_turn/);
  assert.throws(() => move(s, first, 'raise', 51), /raise_too_small/);
  assert.throws(() => move(s, first, 'raise', 1e9), /not_enough_chips/);
  assert.throws(() => move(s, first, 'raise', 1.5 as any), /bad_amount/);
  assert.throws(() => move(s, first, 'dance'), /bad_move/);
  move(s, first, 'raise', 200);
  assert.equal(s.bet, 200);
  assert.equal(s.minRaise, 150);
  assert.ok(s.seats.filter((p) => p.id !== first).every((p) => !p.acted));
});

test('side pots: a short all-in wins only what it covered, the rest goes to the next best hand', () => {
  const s = setup(['short', 'big1', 'big2'], { bots: 0, lobby: false });
  run(s, (x) => x.turn >= 0);
  // set up a river by hand: short is all-in for 100, the others put in 500 each
  s.board = ['2c', '7d', '9h', 'Js', 'Kd'];
  const [short, big1, big2] = ['short', 'big1', 'big2'].map((id) => s.seats.find((p) => p.id === id)!) as [any, any, any];
  short.cards = ['Ah', 'Ad']; big1.cards = ['Kh', 'Qc']; big2.cards = ['3s', '4s'];
  short.committed = 100; big1.committed = 500; big2.committed = 500;
  for (const p of [short, big1, big2]) { p.folded = false; p.out = false; p.bet = 0; }
  const wins = settle(s);
  const won = Object.fromEntries(wins.map((w) => [s.seats[w.seat]!.id, w.amount]));
  assert.deepEqual(won, { short: 300, big1: 800 }, 'short wins 3x100, big1 the side pot of 2x400');
});

test('split pot: the odd chip goes to the first winner left of the dealer', () => {
  const s = setup(['a', 'b', 'c'], { bots: 0, lobby: false });
  run(s, (x) => x.turn >= 0);
  s.board = ['Ah', 'Kd', 'Qc', 'Js', 'Th'];
  for (const p of s.seats) { p.cards = p.id === 'c' ? ['2c', '3d'] : p.id === 'a' ? ['4c', '5d'] : ['6c', '7d']; p.committed = p.id === 'c' ? 1 : 50; p.folded = p.id === 'c'; p.out = false; }
  const wins = settle(s);
  assert.equal(wins.reduce((n, w) => n + w.amount, 0), 101);
  assert.deepEqual(wins.map((w) => w.amount).sort(), [50, 51]);
});

test('view: other hands stay hidden until the showdown, the deck is never sent', () => {
  const s = setup(['a', 'b', 'c'], { bots: 0, lobby: false });
  run(s, (x) => x.turn >= 0);
  const va = viewFor(s, 'a');
  assert.ok(!('deck' in va));
  const me = va.seats[va.you]!;
  assert.equal(me.cards.length, 2);
  assert.ok(me.cards.every((c) => typeof c === 'string'));
  assert.ok(va.seats.filter((p) => !p.me).every((p) => p.cards.length === 2 && p.cards.every((c) => c === null)));
  assert.equal(viewFor(s, null).you, -1);
  assert.ok(viewFor(s, null).seats.every((p) => p.cards.every((c) => c === null)));
});

test('the clock: a player who does not move checks, or folds when there is a bet', () => {
  const s = setup(['a', 'b', 'c'], { bots: 0, lobby: false, timer: 15 });
  run(s, (x) => x.turn >= 0);
  const first = s.seats[s.turn]!;
  assert.ok(toCall(s, s.turn) > 0);
  run(s, (x) => x.turn >= 0 && x.seats[x.turn] !== first, 16_000);
  assert.ok(first.folded);
  assert.equal(first.timeouts, 1);
});

test('full games with bots: chips are never made or lost, and the game ends with places', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = fakeRng(seed);
    now = 0;
    const s = game.setup({ rng: r, now, mode: 'friendly', flags: { lobby: false, bots: 5, chips: 1000, blinds: 4, rebuy: 'none', timer: 15 }, persisted: {}, dm: { persisted: {} }, players: [{ userId: 'me', seat: 0 }] });
    const chips = total(s);
    let hands = 0;
    for (let t = 0; t < 6 * 60 * 60_000 && s.phase === 'play'; t += 250) {
      now += 250;
      // "me" plays: call anything small, else fold
      if (s.turn >= 0 && !s.pending && s.seats[s.turn]!.id === 'me') {
        const c = toCall(s, s.turn);
        move(s, 'me', c === 0 ? 'check' : c <= blinds(s)[1] * 4 ? 'call' : 'fold');
      } else step(s, now, r);
      hands = s.hand;
      assert.equal(total(s), chips, `seed ${seed}: chips stay the same (hand ${s.hand})`);
      assert.ok(s.seats.every((p) => p.stack >= 0), 'no negative stacks');
    }
    assert.equal(s.phase, 'done', `seed ${seed}: the game ended (after ${hands} hands)`);
    const over = game.gameOver!(s, ctx());
    assert.ok(over && 'placements' in over && over.placements.length === 1 && over.placements[0]!.userId === 'me');
  }
});

test('rebuy once: a busted player may buy back in, then they are out for good', () => {
  const s = setup(['a', 'b'], { bots: 0, lobby: false, rebuy: 'once', chips: 1000 });
  run(s, (x) => x.turn >= 0);
  const a = s.seats.find((p) => p.id === 'a')!;
  // a goes all-in every hand, b calls: someone busts soon
  for (let k = 0; k < 400 && s.phase === 'play' && a.rebuys === 0; k++) {
    if (s.turn >= 0 && !s.pending) {
      const p = s.seats[s.turn]!;
      if (p.id === 'a') move(s, 'a', p.bet + p.stack > s.bet ? 'raise' : 'call', p.bet + p.stack);
      else move(s, 'b', toCall(s, s.turn) ? 'call' : 'check');
    }
    now += 250; step(s, now, rng);
    if (a.stack === 0 && a.rebuyUntil > now) call(s, 'rebuy', null, 'a');
    const b = s.seats.find((p) => p.id === 'b')!;
    if (b.stack === 0 && b.rebuyUntil > now) call(s, 'rebuy', null, 'b');
  }
  const busted = s.seats.find((p) => p.rebuys === 1)!;
  assert.ok(busted, 'someone rebought');
  assert.throws(() => call(s, 'rebuy', null, busted.id), /not_now|no_rebuys_left/);
});

test('leaving: the player folds, and a heads-up game ends with the other as winner', () => {
  const s = setup(['a', 'b'], { bots: 0, lobby: false });
  run(s, (x) => x.turn >= 0);
  game.events!.playerLeft!(s, { userId: 'a', seat: 0 }, 'quit', ctx());
  assert.ok(s.seats.find((p) => p.id === 'a')!.folded);
  run(s, (x) => x.phase === 'done');
  assert.equal(s.phase, 'done');
  assert.deepEqual(placements(s).map((p) => p.userId), ['b', 'a']);
  assert.equal(inHand(s).length, 1);
});

test('host ends the game: chips in the middle go back', () => {
  const s = setup(['a', 'b', 'c'], { bots: 0, lobby: false, chips: 1000 });
  run(s, (x) => x.turn >= 0);
  assert.throws(() => call(s, 'end', null, 'b'), /not_host/);
  call(s, 'end', null, 'a');
  assert.equal(s.phase, 'done');
  assert.equal(s.seats.reduce((n, p) => n + p.stack, 0), 3000);
  // everyone level (nobody won a hand yet, blinds went back): a draw
  const level = setup(['x', 'y'], { bots: 0, lobby: false, chips: 1000 });
  run(level, (z) => z.turn >= 0);
  call(level, 'end', null, 'x');
  assert.deepEqual(game.gameOver!(level, ctx()), { draw: true });
});
