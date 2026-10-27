/** Limits for one session. The game server reads them from env; the dev server uses the defaults. */
export interface Limits {
  /** CPU per action / tick; above this counts as a strike (ms). */
  softCpuMs: number;
  /** Hard stop for one action / tick (ms). */
  hardCpuMs: number;
  /** Strikes before the session is ended as ABANDONED. */
  maxStrikes: number;
  /** Memory per session sandbox (MB). */
  memoryMb: number;
  /** Max JSON size of the game state (bytes). */
  maxStateBytes: number;
  /** Max JSON size of one action payload (bytes). */
  maxPayloadBytes: number;
  /** Actions per player per second, and burst. */
  actionsPerSec: number;
  actionsBurst: number;
  /** Recent actions kept for resume. */
  logLength: number;
  /** A session with nobody connected is dropped from memory after this (ms). */
  sleepAfterMs: number;
  /** Keys of a finished session stay in the store this long (s). */
  finishedTtlSec: number;
  /** Max open sockets for one user in one session (tabs, reconnect overlap). */
  socketsPerUser: number;
  /** A short app switch (reading a notification) doesn't start the grace period (ms). */
  awayMs: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  softCpuMs: 10,
  hardCpuMs: 50,
  maxStrikes: 20,
  memoryMb: 32,
  maxStateBytes: 256 * 1024,
  maxPayloadBytes: 4 * 1024,
  actionsPerSec: 20,
  actionsBurst: 40,
  logLength: 500,
  sleepAfterMs: 60_000,
  finishedTtlSec: 3600,
  socketsPerUser: 3,
  awayMs: 10_000,
});
