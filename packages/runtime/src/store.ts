import type { LogEntry, Snapshot } from './types';

/**
 * Where live sessions are kept between actions, so any worker can continue a
 * session after a crash, deploy or sleep. Production: the game Redis
 * (LiveStreamCoin-GameRedis). Dev / tests: memory.
 *
 * All keys live under `game:` (the Redis ACL only allows that prefix).
 */
export interface Store {
  loadSnapshot(ses: string): Promise<Snapshot | null>;
  /**
   * Saves the new snapshot, appends the log entry (capped) and remembers the
   * client's action id, in ONE atomic step. Called before anything is broadcast.
   */
  commit(ses: string, snap: Snapshot, entry: LogEntry | null, dedupe: { userId: string; id: string } | null): Promise<void>;
  /** Entries with seq > fromSeq, or null when the log no longer reaches back that far. */
  readLog(ses: string, fromSeq: number): Promise<LogEntry[] | null>;
  /** The seq an action id got, if this client already sent it (exactly-once). */
  seenAction(ses: string, userId: string, id: string): Promise<number | null>;
  /** Owner lock: only one worker runs a session. */
  claim(ses: string, workerId: string, ttlMs: number): Promise<boolean>;
  renew(ses: string, workerId: string, ttlMs: number): Promise<boolean>;
  release(ses: string, workerId: string): Promise<void>;
  /** After the end: keep keys a while (late reconnects see the result), then let them expire. */
  expire(ses: string, ttlSec: number): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export const DEDUPE_TTL_SEC = 300;
