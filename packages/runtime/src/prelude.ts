/**
 * JavaScript that runs INSIDE each session's isolate before the game bundle.
 *
 * - Removes every source of non-determinism (Math.random, Date, …) so the same
 *   inputs always give the same state. Randomness comes from a seeded RNG whose
 *   state travels with the session snapshot.
 * - Defines __vibesCall(kind, inputJson) → outputJson, the only door between the
 *   host and the game. Everything crosses as JSON strings (copied, never shared).
 *
 * The game bundle must set `globalThis.__vibesGame = { setup, actions, gameOver, ... }`
 * (the CLI builds it with esbuild --format=iife).
 */
export const PRELUDE = String.raw`
(function () {
  'use strict';
  const banned = (what) => function () { throw new Error(what + ' is not allowed in game logic (use ctx.rng / ctx.now)'); };
  Math.random = banned('Math.random');
  const BannedDate = banned('Date');
  BannedDate.now = banned('Date.now');
  globalThis.Date = BannedDate;
  for (const name of ['WeakRef', 'FinalizationRegistry', 'SharedArrayBuffer', 'Atomics']) {
    try { delete globalThis[name]; } catch (e) { globalThis[name] = undefined; }
  }

  // mulberry32: tiny, fast, good enough for games; state is one uint32.
  function makeRng(state) {
    let s = state >>> 0;
    const next = () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (min, max) => { if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new Error('rng.int(min, max) needs integers, min <= max'); return min + Math.floor(next() * (max - min + 1)); };
    return {
      next,
      int,
      pick: (arr) => { if (!Array.isArray(arr) || arr.length === 0) throw new Error('rng.pick needs a non-empty array'); return arr[int(0, arr.length - 1)]; },
      shuffle: (arr) => { const a = Array.from(arr); for (let i = a.length - 1; i > 0; i--) { const j = int(0, i); const x = a[i]; a[i] = a[j]; a[j] = x; } return a; },
      _state: () => s,
    };
  }

  const CODE = /^[a-z0-9_]{1,64}$/;
  const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

  class Rejected extends Error {}

  function views(g, state, viewers) {
    if (typeof g.view !== 'function') return null;
    // Each view gets its own copy, so a view() that mutates can't change the real state.
    const json = JSON.stringify(state);
    const out = {};
    for (const id of viewers) out[id === null ? '' : id] = g.view(JSON.parse(json), id);
    return out;
  }

  function turnOf(g, state, now) {
    const t = g.turnTimer;
    if (!t || typeof t.whoseTurn !== 'function' || !(t.seconds > 0)) return null;
    const userId = t.whoseTurn(state);
    return typeof userId === 'string' ? { userId, seconds: t.seconds } : null;
  }

  globalThis.__vibesCall = function (kind, inputJson) {
    const g = globalThis.__vibesGame;
    if (!g || typeof g !== 'object') throw new Error('bundle did not set globalThis.__vibesGame');
    const input = JSON.parse(inputJson);
    const rng = makeRng(input.rng);
    const persisted = input.persisted;
    const base = { rng, now: input.now, mode: input.mode, flags: input.flags, persisted: persisted.players, dm: { persisted: persisted.dm } };
    let state = input.state;

    if (kind === 'meta') {
      return JSON.stringify({
        minPlayers: g.minPlayers | 0, maxPlayers: g.maxPlayers | 0,
        tickHz: g.tickHz | 0, hasView: typeof g.view === 'function',
        actions: Object.keys(g.actions || {}),
        handlesLeave: !!(g.events && typeof g.events.playerLeft === 'function'),
      });
    }

    try {
      if (kind === 'peek') {
        // no change: only recompute views / turn (after a session wakes up from the store)
      } else if (kind === 'setup') {
        state = g.setup(Object.assign({ players: input.players }, base));
      } else if (kind === 'action') {
        if (!own(g.actions, input.name) || typeof g.actions[input.name] !== 'function') throw new Rejected('unknown_action');
        const r = g.actions[input.name](state, input.payload, Object.assign({ playerId: input.playerId }, base));
        if (r !== undefined) state = r;
      } else if (kind === 'tick') {
        if (typeof g.update !== 'function') throw new Error('no update()');
        const r = g.update(state, Object.assign({ dt: input.dt }, base));
        if (r !== undefined) state = r;
      } else if (kind === 'timeout') {
        const t = g.turnTimer;
        if (t && typeof t.onTimeout === 'function') { const r = t.onTimeout(state, input.playerId, base); if (r !== undefined) state = r; }
      } else if (kind === 'joined' || kind === 'left') {
        const fn = g.events && g.events[kind === 'joined' ? 'playerJoined' : 'playerLeft'];
        if (typeof fn === 'function') { const r = fn(state, input.player, input.reason, base); if (r !== undefined) state = r; }
      } else {
        throw new Error('unknown call ' + kind);
      }
    } catch (e) {
      // A throw from an action is a normal "no" (not your turn, bad cell…). The state was a
      // copy, so nothing leaks. A throw anywhere else is a crash of the game logic.
      if (kind === 'action' || e instanceof Rejected) {
        const msg = e && typeof e.message === 'string' && CODE.test(e.message) ? e.message : 'rejected';
        return JSON.stringify({ rejected: msg });
      }
      throw e;
    }

    const over = typeof g.gameOver === 'function' ? (g.gameOver(state, base) || null) : null;
    return JSON.stringify({
      state,
      rng: rng._state(),
      over,
      views: views(g, state, input.viewers),
      turn: over ? null : turnOf(g, state, input.now),
      persisted,
    });
  };
})();
`;
