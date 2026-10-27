import type { LogEntry, Result, SessionConfig, Status } from './types';

export interface Outcome {
  status: Exclude<Status, 'RUNNING'>;
  result: Result | null;
  reason: string;
  finalState: unknown;
  /** The whole resume log we still have (the backend stores it as one gzip file). */
  log: LogEntry[];
  persisted: SessionConfig['persisted'];
  startedAt: number;
  endedAt: number;
  actions: number;
}

/**
 * The game server's only link to the rest of VIBES. It never touches Postgres:
 * the backend owns sessions, results, ratings and DM cards, and tells us what
 * a session is when the first player connects.
 */
export interface Registry {
  /** Session config, or null if unknown / not started / not for this server. */
  load(sessionId: string): Promise<SessionConfig | null>;
  /** First time the session is set up (seq 0). */
  started(sessionId: string, at: number): Promise<void>;
  /** Final outcome. Must be idempotent on the backend (we retry). */
  finished(sessionId: string, outcome: Outcome): Promise<void>;
}
