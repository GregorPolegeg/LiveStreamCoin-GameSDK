# Tic Tac Toe

A game for VIBES DMs, made with `create-vibes-game`.

## Start

```bash
npm install
npm run dev        # opens a local session with one window per player
```

Open the URL it prints. Each window is a different player. Change a file and the windows reload.

## Files

| Path | What |
|---|---|
| `vibes.json` | Name, slug, player count, modes, reconnect and time limits |
| `logic/index.ts` | The rules. Runs on VIBES servers in a sandbox and decides every move |
| `logic/rules.ts` | Helpers used by the rules (split into as many files as you like) |
| `client/` | The screen: `index.html`, `main.ts`, `style.css`. Any web framework works |
| `test/` | Unit tests for the rules |

## Rules for the logic

- No `Math.random`, `Date`, timers, `fetch` or Node APIs. Use `ctx.rng` for randomness and `ctx.now` for time.
- Keep everything in `state` (plain JSON, max 256 KB). No module-level variables that change.
- Say no to a move with `throw new Error('some_code')`. The player's client gets that code.

## Commands

```bash
npm run dev        # local multiplayer: --players 2, --port 5173
npm test           # unit tests
npm run check      # the same automatic checks VIBES runs before a release
npm run build      # dist/logic.js and dist/client/
```

`npm run check` plays hundreds of random games in the real sandbox, twice each, and fails if the
logic crashes, uses a banned API, or does not give the same result for the same seed.
