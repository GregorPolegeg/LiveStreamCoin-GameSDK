// Texas Hold'em for VIBES DMs and group chats: 1-9 people, empty seats can be bots. Play chips only.
// This runs on VIBES servers in a sandbox and is the only referee: it deals, takes the bets, splits
// the pots and moves the bots. No Math.random, Date, timers, fetch or Node APIs: ctx.rng and ctx.now.
import { defineGame } from '@vibes/games-logic';
import { act, changeSettings, DEFAULT_SETTINGS, endGame, leave, newState, placements, readSettings, rebuy, sitOut, start, step, viewFor, type State, type View } from './rules';

export type { State, View, SeatView, Settings, HandResult, Kind } from './rules';

const seatOf = (s: State, id: string) => s.seats.findIndex((p) => p.id === id && !p.bot);

export default defineGame({
  minPlayers: 1,
  maxPlayers: 9,

  // Start options (flags): { chips, blinds (0-4), up (minutes: 0/5/10/15), rebuy: 'none'|'once'|'any',
  // timer (15/30/60 s), bots (0-8), lobby: false to deal right away (Play again) }.
  setup({ players, flags, now, rng }): State {
    const s = newState(players, readSettings(flags, DEFAULT_SETTINGS, players.length));
    if (flags.lobby === false) start(s, null, now, rng);
    return s;
  },

  actions: {
    /** Lobby, host only: change any of the settings. Everyone sees it at once. */
    settings(state: State, change: { chips?: number; blinds?: number; up?: number; rebuy?: string; timer?: number; bots?: number }, { playerId }) {
      changeSettings(state, playerId, change);
    },
    /** Lobby, host only: deal the first hand. */
    start(state: State, _: null, { playerId, now, rng }) {
      start(state, playerId, now, rng);
    },
    /** Your move: { kind: 'fold' | 'check' | 'call' } or { kind: 'raise', to: <total bet> }. */
    move(state: State, m: { kind: 'fold' | 'check' | 'call' | 'raise'; to?: number }, { playerId, now, rng }) {
      if (!m || typeof m !== 'object') throw new Error('bad_move');
      act(state, seatOf(state, playerId), m.kind, m.to, now, rng);
    },
    /** Out of chips: buy back in with the starting chips (when the table allows it). */
    rebuy(state: State, _: null, { playerId, now }) {
      rebuy(state, playerId, now);
    },
    /** Out of chips: don't rebuy, just watch. */
    watch(state: State, _: null, { playerId }) {
      sitOut(state, playerId);
    },
    /** Host: end the game now (chips in the middle go back). */
    end(state: State, _: null, { playerId }) {
      endGame(state, playerId);
    },
  },

  // The clock: turn timers, the bots, and the pauses between streets and hands.
  tickHz: 4,
  update(state, { now, rng }) {
    step(state, now, rng);
  },

  view: (state, viewerId): View => viewFor(state, viewerId),

  events: {
    playerLeft(state, player, _reason, { now, rng }) {
      leave(state, player.userId, now, rng);
    },
  },

  gameOver(state) {
    if (state.phase !== 'done') return null;
    const rows = placements(state);
    // nobody real at the table, or everyone ended level: a draw (like Guess the Flag)
    if (!rows.length || (rows.length > 1 && rows.every((r) => r.place === 1))) return { draw: true };
    // rest: 1 because every player is listed (VIB-215)
    return { placements: rows, rest: 1 };
  },
});
