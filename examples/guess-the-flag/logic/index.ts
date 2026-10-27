// Guess the Flag for VIBES DMs and group chats: 1-16 players, everyone answers the same flag at once.
// This runs on VIBES servers in a sandbox and is the only referee:
// no Math.random, Date, timers, fetch or Node APIs. Use ctx.rng and ctx.now.
import { defineGame } from '@vibes/games-logic';
import { answer, changeSettings, DEFAULT_SETTINGS, leave, newState, placements, readSettings, start, step, viewFor, type State, type View } from './rules';

export type { State, View, Pool, AnswerMode, Settings } from './rules';

export default defineGame({
  minPlayers: 1,
  maxPlayers: 16,

  // Start options (flags) only fill in the lobby: { mode: 'cards' | 'text', seconds: 5-60, rounds: 3-30,
  // pool: 'famous' | 'all' | 'europe' | 'asia' | 'africa' | 'americas' | 'oceania', lobby: false to start right away }.
  setup({ players, rng, flags }): State {
    return newState(players.map((p) => p.userId), readSettings(flags, DEFAULT_SETTINGS), rng, flags.lobby !== false);
  },

  actions: {
    /** Lobby: change any of { mode, seconds, rounds, pool }. Everyone sees it at once. */
    settings(state: State, change: { mode?: string; seconds?: number; rounds?: number; pool?: string }, { playerId }) {
      changeSettings(state, playerId, change);
    },
    /** Lobby: start the game for everyone. */
    start(state: State, _: null, { rng }) {
      start(state, rng);
    },
    /** Your answer: a country code (one of the four cards, or any country when typing). One answer per flag. */
    answer(state: State, pick: string, { playerId }) {
      answer(state, playerId, pick);
    },
  },

  // The clock: question time, then 3.5 s to see the answer, then the next flag.
  tickHz: 10,
  update(state, { dt, rng }) {
    step(state, dt, rng);
  },

  view: (state, viewerId): View => viewFor(state, viewerId),

  events: {
    playerLeft(state, player) {
      leave(state, player.userId);
    },
  },

  gameOver(state) {
    if (state.phase !== 'done') return null;
    const rows = placements(state);
    if (rows.length > 1 && rows.every((r) => r.place === 1)) return { draw: true };
    // rest: 1 because every player is listed (VIB-215: the default rest can be out of range).
    return { placements: rows, rest: 1 };
  },
});
