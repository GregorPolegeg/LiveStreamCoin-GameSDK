// Unit tests for the rules: call the logic directly with a fake ctx. Run with `npm test`.
// `npm run check` then plays hundreds of random games in the real sandbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ctx, Rng } from '@vibes/games-logic';
import game, { type State } from '../logic';
import { ALL, FAMOUS, regionOf } from '../logic/countries';
import { BASE_POINTS, REVEAL_MS, step, viewFor } from '../logic/rules';

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

const rng = fakeRng();
const ctx = (flags: Record<string, unknown> = {}): Ctx => ({ rng, now: 0, mode: 'friendly', flags, persisted: {}, dm: { persisted: {} } });
const lobby = (ids = ['alice', 'bob', 'carol'], flags = {}): State => game.setup({ ...ctx(flags), players: ids.map((userId, seat) => ({ userId, seat })) });
/** Skips the lobby, like a game set up before it started. */
const newGame = (ids = ['alice', 'bob', 'carol'], flags = {}): State => lobby(ids, { ...flags, lobby: false });
const act = (s: State, name: 'settings' | 'start', payload: unknown, id = 'alice') => (game.actions[name] as any)(s, payload, { ...ctx(), playerId: id });
const pick = (s: State, id: string, code: string) => game.actions.answer(s, code, { ...ctx(), playerId: id });
const wrongOf = (s: State) => s.q.options.find((c) => c !== s.q.flag)!;
const tick = (s: State, ms: number) => { for (let t = 0; t < ms; t += 100) step(s, 100, rng); };

test('countries: every code is unique, has a continent, and famous flags are in the list', () => {
  assert.equal(new Set(ALL).size, ALL.length);
  for (const c of ALL) assert.ok(regionOf(c));
  for (const c of FAMOUS) assert.ok(ALL.includes(c), c);
});

test('setup: four different options with the right one among them, start options clamped', () => {
  const s = newGame(['alice'], { rounds: 7, seconds: 99, pool: 'europe' });
  assert.deepEqual(s.settings, { mode: 'cards', seconds: 15, rounds: 7, pool: 'europe' });
  assert.equal(new Set(s.q.options).size, 4);
  assert.ok(s.q.options.includes(s.q.flag));
  assert.equal(regionOf(s.q.flag), 'europe');
  assert.equal(newGame(['a'], { pool: 'mars' }).settings.pool, 'famous');
});

test('answer: one per flag, only the four options, faster right answers score more', () => {
  const s = newGame();
  assert.throws(() => pick(s, 'alice', 'zz'), /bad_option/);
  pick(s, 'alice', s.q.flag);
  assert.throws(() => pick(s, 'alice', s.q.flag), /already_answered/);
  tick(s, 5000);
  pick(s, 'bob', s.q.flag);
  pick(s, 'carol', wrongOf(s)); // everyone answered: reveal now, no waiting
  assert.equal(s.phase, 'reveal');
  assert.ok(s.scores.alice! > s.scores.bob!);
  assert.ok(s.scores.bob! >= 100);
  assert.equal(s.scores.carol, 0);
});

test('view: the answer and other players\' picks stay hidden until the reveal', () => {
  const s = newGame();
  pick(s, 'alice', wrongOf(s));
  const forBob = viewFor(s, 'bob');
  assert.equal(forBob.answer, null);
  assert.deepEqual(forBob.answers, {});
  assert.deepEqual(forBob.answered, ['alice']);
  assert.deepEqual(Object.keys(viewFor(s, 'alice').answers), ['alice']);
  tick(s, s.settings.seconds * 1000 + 100);
  assert.equal(s.phase, 'reveal');
  assert.equal(viewFor(s, 'bob').answer, s.q.flag);
});

test('a full game: no flag twice, ends after the last reveal with places by score', () => {
  const s = newGame(['alice', 'bob'], { rounds: 5 });
  const seen = new Set<string>();
  for (let r = 0; r < 5; r++) {
    seen.add(s.q.flag);
    pick(s, 'alice', s.q.flag);
    pick(s, 'bob', wrongOf(s));
    assert.equal(game.gameOver?.(s, ctx()), null);
    tick(s, REVEAL_MS + 100);
  }
  assert.equal(seen.size, 5);
  assert.equal(s.phase, 'done');
  assert.equal(s.streaks.alice, 5);
  const over = game.gameOver?.(s, ctx());
  assert.ok(over && 'placements' in over);
  assert.deepEqual(over.placements.map((p) => [p.userId, p.place]), [['alice', 1], ['bob', 2]]);
});

test('playerLeft: nobody waits for a player who left; solo games end with a valid result', () => {
  const s = newGame(['alice', 'bob']);
  pick(s, 'alice', s.q.flag);
  game.events!.playerLeft!(s, { userId: 'bob', seat: 1 }, 'quit', ctx());
  assert.equal(s.phase, 'reveal');

  const solo = newGame(['alice'], { rounds: 5 });
  for (let r = 0; r < 5; r++) { pick(solo, 'alice', solo.q.flag); tick(solo, REVEAL_MS + 100); }
  const over = game.gameOver?.(solo, ctx());
  assert.ok(over && 'placements' in over);
  assert.equal(over.placements[0]!.place, 1);
});

test('lobby: any player changes the settings, anyone starts; settings lock after the start', () => {
  const s = lobby();
  assert.equal(s.phase, 'lobby');
  tick(s, 60_000);
  assert.equal(s.phase, 'lobby', 'the lobby has no clock');
  assert.throws(() => game.actions.answer(s, 'at', { ...ctx(), playerId: 'alice' }), /not_now/);
  act(s, 'settings', { mode: 'text', seconds: 30 }, 'bob');
  assert.deepEqual(s.settings, { mode: 'text', seconds: 30, rounds: 10, pool: 'famous' });
  assert.equal(s.changedBy, 'bob');
  assert.throws(() => act(s, 'settings', { seconds: 999 }), /bad_settings/);
  assert.throws(() => act(s, 'settings', 'fast'), /bad_settings/);
  act(s, 'start', null, 'carol');
  assert.equal(s.phase, 'question');
  assert.equal(s.left, 30_000);
  assert.throws(() => act(s, 'settings', { seconds: 5 }), /already_started/);
  assert.throws(() => act(s, 'start', null), /already_started/);
});

test('text mode: no cards; any country is a valid answer; typed right answers score more', () => {
  const s = newGame(['alice', 'bob'], { mode: 'text' });
  assert.deepEqual(s.q.options, []);
  assert.deepEqual(viewFor(s, 'alice').options, []);
  assert.throws(() => pick(s, 'alice', 'zz'), /bad_option/);
  const wrong = ALL.find((c) => c !== s.q.flag)!;
  pick(s, 'bob', wrong);
  pick(s, 'alice', s.q.flag);
  assert.equal(s.phase, 'reveal');
  assert.ok(s.scores.alice! >= BASE_POINTS.text);
  assert.equal(s.scores.bob, 0);
});
