// Unit tests for the rules: call the logic functions directly with a fake ctx.
// Run with `npm test`. `npm run check` then plays hundreds of random games in the real sandbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ctx, Rng } from '@vibes/games-logic';
import game, { type State } from '../logic';

/** A tiny seeded RNG, like the one VIBES gives the logic (same seed, same numbers). */
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

const ctx = (): Ctx => ({ rng: fakeRng(), now: 0, mode: 'friendly', flags: {}, persisted: {}, dm: { persisted: {} } });
const players = [{ userId: 'alice', seat: 0 }, { userId: 'bob', seat: 1 }];

function newGame(): State {
  return game.setup({ ...ctx(), players });
}

/** Plays a move like the server does: on a copy, the action may change it in place. */
function play(state: State, cell: unknown, playerId: string): State {
  const s = structuredClone(state);
  const out = game.actions.place(s, cell as number, { ...ctx(), playerId });
  return out ?? s;
}

test('setup: empty board, both players in the turn order', () => {
  const s = newGame();
  assert.deepEqual(s.board, Array(9).fill(null));
  assert.deepEqual([...s.order].sort(), ['alice', 'bob']);
  assert.equal(s.turn, s.order[0]);
});

test('place: only on your turn, only free cells on the board', () => {
  const s = newGame();
  const [first, second] = s.order as [string, string];
  assert.throws(() => play(s, 4, second), /not_your_turn/);
  assert.throws(() => play(s, 9, first), /bad_cell/);
  assert.throws(() => play(s, 'x', first), /bad_cell/);
  const after = play(s, 4, first);
  assert.equal(after.board[4], first);
  assert.equal(after.turn, second);
  assert.throws(() => play(after, 4, second), /taken/);
});

test('gameOver: three in a row wins, a full board is a draw', () => {
  let s = newGame();
  const [x, o] = s.order as [string, string];
  for (const [cell, who] of [[0, x], [3, o], [1, x], [4, o]] as const) s = play(s, cell, who);
  assert.equal(game.gameOver?.(s, ctx()), null);
  s = play(s, 2, x);
  assert.deepEqual(game.gameOver?.(s, ctx()), { placements: [{ userId: x, place: 1 }], rest: 2 });

  const full: State = { ...newGame(), board: [x, o, x, x, o, o, o, x, x] };
  assert.deepEqual(game.gameOver?.(full, ctx()), { draw: true });
});

test('turn timer: a timeout takes a free cell for the player and passes the turn', () => {
  const s = newGame();
  const first = s.turn;
  const out = game.turnTimer!.onTimeout(s, first, ctx()) ?? s;
  assert.equal(out.board.filter((v) => v === first).length, 1);
  assert.notEqual(out.turn, first);
});
