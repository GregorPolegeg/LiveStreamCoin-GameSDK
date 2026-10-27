// The rules of the game. This runs on VIBES servers in a sandbox and is the only referee:
// no Math.random, Date, timers, fetch or Node APIs. Use ctx.rng and ctx.now.
import { defineGame } from '@vibes/games-logic';
import { freeCells, isCell, place, winner, type State } from './rules';

export type { State } from './rules';

export default defineGame({
  minPlayers: 2,
  maxPlayers: 2,

  // Called once when the session starts.
  setup({ players, rng }): State {
    const order = rng.shuffle(players.map((p) => p.userId));
    return { board: Array<string | null>(9).fill(null), turn: order[0]!, order };
  },

  // Everything a player may ask for. Throw new Error('some_code') to say no.
  actions: {
    place(state: State, cell: number, { playerId }) {
      if (state.turn !== playerId) throw new Error('not_your_turn');
      if (!isCell(cell)) throw new Error('bad_cell');
      if (state.board[cell]) throw new Error('taken');
      place(state, cell, playerId);
    },
  },

  // VIBES runs the clock. When it runs out, a random free cell is taken for that player.
  turnTimer: {
    seconds: 30,
    whoseTurn: (state) => state.turn,
    onTimeout(state, playerId, { rng }) {
      const free = freeCells(state.board);
      if (free.length) place(state, rng.pick(free), playerId);
    },
  },

  // Checked after every change. Return a result to end the game.
  gameOver(state) {
    const w = winner(state.board);
    if (w) return { placements: [{ userId: w, place: 1 }], rest: 2 };
    if (state.board.every(Boolean)) return { draw: true };
    return null;
  },
});
