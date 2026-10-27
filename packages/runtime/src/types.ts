/** Shapes shared by the registry, the store, the session and the sandbox. */

export type Mode = 'friendly' | 'competitive' | 'practice';
export type Status = 'RUNNING' | 'COMPLETED' | 'ABANDONED';

export interface Player {
  userId: string;
  seat: number;
  displayName?: string;
  avatarUrl?: string | null;
  color?: string;
}

/** What the backend tells us about a session when it starts (immutable). */
export interface SessionConfig {
  id: string;
  appId: string;
  versionId: string;
  dmId: string;
  mode: Mode;
  flags: Record<string, unknown>;
  seed: string;
  players: Player[];
  spectators: boolean;
  /** The approved logic bundle and its hash (checked before it runs). */
  logic: { code: string; sha256: string };
  /** How long a disconnected player is waited for. 0 = never counts as leaving (async games). */
  reconnectGraceSec: number;
  /** No frames at all for this long → ABANDONED. Async turn-based games get a long one. */
  idleTimeoutSec: number;
  maxDurationSec: number;
  /** Saved player / DM data of this game, loaded by the backend. */
  persisted: { players: Record<string, unknown>; dm: unknown };
}

export interface Placement { userId: string; place: number; score?: number }
export interface Result { placements: Placement[]; draw: boolean }

export interface TurnInfo { userId: string; deadline: number }

/** Everything needed to continue a session on any worker. Saved after every accepted action. */
export interface Snapshot {
  status: Status;
  seq: number;
  state: unknown;
  rng: number;
  startedAt: number;
  updatedAt: number;
  strikes: number;
  turn: TurnInfo | null;
  result: Result | null;
  persisted: { players: Record<string, unknown>; dm: unknown };
  /** Players who left for good (grace ran out or quit). */
  left: string[];
  endReason?: string;
}

/** One accepted action (or system event) in the resume log. */
export interface LogEntry {
  seq: number;
  by: string | null;
  name: string;
  p: unknown;
  at: number;
}
