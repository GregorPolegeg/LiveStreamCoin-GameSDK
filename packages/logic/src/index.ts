/**
 * @vibes/games-logic — types for a VIBES game's rules (logic/index.ts).
 *
 *   import { defineGame } from '@vibes/games-logic';
 *   export default defineGame({ minPlayers: 2, maxPlayers: 2, setup, actions, gameOver });
 *
 * The logic runs on VIBES servers (and in `vibes-games dev`) in a sandbox:
 * no Math.random, Date, timers, fetch or Node APIs. Use ctx.rng and ctx.now.
 * The CLI bundles it into one file; nothing here is needed at runtime.
 */

export type Mode = 'friendly' | 'competitive' | 'practice';

export interface Player {
  userId: string;
  seat: number;
  displayName?: string;
  avatarUrl?: string | null;
  color?: string;
}

/** Seeded per session; same seed + same actions = same game. */
export interface Rng {
  /** [0, 1) */
  next(): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** A shuffled copy. */
  shuffle<T>(items: readonly T[]): T[];
}

export interface Ctx<P = Record<string, unknown>, D = Record<string, unknown>> {
  rng: Rng;
  /** Server time (ms). The same for everyone in one call. */
  now: number;
  mode: Mode;
  /** Options chosen when the game was started (e.g. bestOf). */
  flags: Record<string, unknown>;
  /** Saved data per player for THIS game (≤ 32 KB each), kept by VIBES between sessions. */
  persisted: Record<string, P>;
  /** Saved data for this DM / friend group (≤ 32 KB). */
  dm: { persisted: D };
}

export type ActionCtx<P = any, D = any> = Ctx<P, D> & { playerId: string };

/** Throw new Error('some_code') in an action to say no. Codes: [a-z0-9_], ≤ 64 chars. */
export type Action<S, A = any, P = any, D = any> = (state: S, payload: A, ctx: ActionCtx<P, D>) => S | void;

export type GameOver =
  | { draw: true }
  /** Players not listed get place `rest` (default: last listed place + 1). */
  | { placements: { userId: string; place: number; score?: number }[]; rest?: number };

export interface GameLogic<S, Acts extends Record<string, Action<S, any, any, any>> = Record<string, Action<S>>, P = any, D = any> {
  minPlayers: number;
  maxPlayers: number;
  setup(ctx: Ctx<P, D> & { players: Player[] }): S;
  actions: Acts;
  /** Checked after every change; return a result to end the game. */
  gameOver?(state: S, ctx: Ctx<P, D>): GameOver | null | undefined | void;
  /** Real-time games: called tickHz times per second (max 30). */
  tickHz?: number;
  update?(state: S, ctx: Ctx<P, D> & { dt: number }): S | void;
  /**
   * Hidden information: what each player may see (viewerId null = spectator).
   * With view(), players never get the full state.
   */
  view?(state: S, viewerId: string | null): unknown;
  /** Turn clock run by VIBES; onTimeout is called when it runs out. */
  turnTimer?: {
    seconds: number;
    whoseTurn(state: S): string | null | undefined;
    onTimeout(state: S, playerId: string, ctx: Ctx<P, D>): S | void;
  };
  events?: {
    /** A player left for good (grace period ran out or quit). Without this, VIBES applies the default rule. */
    playerLeft?(state: S, player: Player, reason: 'timeout' | 'quit', ctx: Ctx<P, D>): S | void;
  };
}

/** Identity helper that gives full type inference for your game. */
export function defineGame<S, Acts extends Record<string, Action<S, any, any, any>>, P = any, D = any>(
  game: GameLogic<S, Acts, P, D>,
): GameLogic<S, Acts, P, D> {
  return game;
}

/** Payload type of each action, for the typed client: Vibes.actions.place(4). */
export type ActionPayloads<G> = G extends GameLogic<any, infer Acts, any, any>
  ? { [K in keyof Acts]: Acts[K] extends (s: any, payload: infer A, ctx: any) => any ? A : never }
  : never;

/** State type of a game (or its view type when it has view()). */
export type StateOf<G> = G extends GameLogic<infer S, any, any, any> ? S : never;
