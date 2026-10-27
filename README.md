# VIBES Game SDK

Build multiplayer games that people play **inside VIBES DMs**. You write the rules and the screen; VIBES hosts the game, runs every session, keeps the score and handles all the multiplayer: order of moves, reconnects, turn timers, results.

| Package | What |
|---|---|
| [`@vibes/games`](packages/games) | Client SDK for your game's screen. `Vibes.init({ onChange })`, `vibes.actions.place(4)`. All the networking you write |
| [`@vibes/games-logic`](packages/logic) | Types for your game's rules: `defineGame({ setup, actions, gameOver })` |
| [`vibes-games`](packages/cli) | CLI: `dev` (local multiplayer), `check` (the same automatic checks VIBES runs), `build`, `upload` |
| [`create-vibes-game`](packages/create) | `npx create-vibes-game my-game` |
| [`@vibes/game-runtime`](packages/runtime) | The sandbox + session engine. The VIBES game server and `vibes-games dev` run this same code |

## How a game works

```
logic/index.ts   →  runs on VIBES servers, in a sandbox, as the only referee
client/          →  your HTML/JS screen, served from games.vibes.stream
```

```ts
// logic/index.ts
import { defineGame } from '@vibes/games-logic';

export default defineGame({
  minPlayers: 2,
  maxPlayers: 2,
  setup: ({ players, rng }) => ({ board: Array(9).fill(null), order: rng.shuffle(players.map((p) => p.userId)), turn: 0 }),
  actions: {
    place(state, cell: number, { playerId }) {
      if (state.order[state.turn % 2] !== playerId) throw new Error('not_your_turn');
      if (state.board[cell] !== null) throw new Error('taken');
      state.board[cell] = playerId;
      state.turn++;
    },
  },
  gameOver: (state) => (state.board.every(Boolean) ? { draw: true } : null),
});
```

```ts
// client/main.ts
import { Vibes } from '@vibes/games';
import type game from '../logic';

const vibes = Vibes.init<typeof game>({ onChange: ({ state, me }) => render(state, me) });
cell.onclick = () => vibes.actions.place(4).catch((e) => toast(e.code));
```

Rules for logic: no `Math.random`, `Date`, timers, `fetch` or Node APIs. Use `ctx.rng` and `ctx.now`. Same seed + same moves = same game, which is what makes scores trustworthy.

Full platform spec: `VIBES-DM-GAMES.md` (VIBES internal).

## Make a game

```bash
npx create-vibes-game my-game
cd my-game && npm install
npm run dev        # all players side by side in the browser, live reload, "drop connection" per player
npm run check      # the same automatic checks VIBES runs before review (determinism, purity, crashes, speed)
npm test
```

## Develop this repo

```bash
npm install
npm run build
npm test
```

Tests: `packages/runtime` (sandbox + multiplayer over real WebSockets), `packages/games` (the SDK against the runtime), `packages/cli` (build + check pass/fail).
