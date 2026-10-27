/** In-process store for dev and tests. Not for production: nothing survives a restart. */
import type { LogEntry, Snapshot } from './types';
import { DEDUPE_TTL_SEC, type Store } from './store';

export class MemoryStore implements Store {
  private snaps = new Map<string, string>();
  private logs = new Map<string, LogEntry[]>();
  private dedupe = new Map<string, { seq: number; until: number }>();
  private owners = new Map<string, { worker: string; until: number }>();

  constructor(private readonly logLength = 500) {}

  async loadSnapshot(ses: string) {
    const s = this.snaps.get(ses);
    return s ? (JSON.parse(s) as Snapshot) : null;
  }

  async commit(ses: string, snap: Snapshot, entry: LogEntry | null, d: { userId: string; id: string } | null) {
    this.snaps.set(ses, JSON.stringify(snap));
    if (entry) {
      const log = this.logs.get(ses) ?? [];
      log.push(entry);
      if (log.length > this.logLength) log.splice(0, log.length - this.logLength);
      this.logs.set(ses, log);
    }
    if (d) this.dedupe.set(`${ses}:${d.userId}:${d.id}`, { seq: snap.seq, until: Date.now() + DEDUPE_TTL_SEC * 1000 });
  }

  async readLog(ses: string, fromSeq: number) {
    const log = this.logs.get(ses) ?? [];
    const first = log[0];
    if (first && first.seq > fromSeq + 1) return null;
    if (!first && fromSeq < ((await this.loadSnapshot(ses))?.seq ?? 0)) return null;
    return log.filter((e) => e.seq > fromSeq);
  }

  async seenAction(ses: string, userId: string, id: string) {
    const v = this.dedupe.get(`${ses}:${userId}:${id}`);
    return v && v.until > Date.now() ? v.seq : null;
  }

  async claim(ses: string, worker: string, ttlMs: number) {
    const o = this.owners.get(ses);
    if (o && o.until > Date.now() && o.worker !== worker) return false;
    this.owners.set(ses, { worker, until: Date.now() + ttlMs });
    return true;
  }

  async renew(ses: string, worker: string, ttlMs: number) {
    const o = this.owners.get(ses);
    if (!o || o.worker !== worker) return false;
    o.until = Date.now() + ttlMs;
    return true;
  }

  async release(ses: string, worker: string) {
    if (this.owners.get(ses)?.worker === worker) this.owners.delete(ses);
  }

  async expire() { /* memory store keeps everything until the process ends */ }
  async ping() { return true; }
  async close() {}
}
