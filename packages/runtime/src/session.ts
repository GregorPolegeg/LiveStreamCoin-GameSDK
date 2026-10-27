/**
 * One live game session on this worker.
 *
 * Rules that keep multiplayer correct:
 * - Everything that changes the game runs through ONE queue, so actions get a
 *   single order (seq 1, 2, 3 …) that every player sees.
 * - A change is saved to the store BEFORE it is sent to anyone, so a crash never
 *   shows players a state that is lost.
 * - The client's action id is remembered (5 min), so a resend after a reconnect
 *   is answered with the same seq instead of being applied twice.
 * - Only the owner worker (lock in the store) runs a session. If we lose the lock,
 *   we stop at once and tell clients to reconnect.
 */
import type { Limits } from './limits';
import { log } from './log';
import type { Registry } from './registry';
import { Sandbox, SandboxError, type CallOutput, type GameMeta } from './sandbox';
import type { Store } from './store';
import type { LogEntry, Placement, Player, Result, SessionConfig, Snapshot, Status } from './types';

export interface Conn {
  readonly userId: string;
  readonly role: 'player' | 'spectator';
  send(frame: object): void;
  close(code: number, reason: string): void;
}

export class OwnerBusy extends Error {}

const OWNER_TTL_MS = 15_000;
const OWNER_RENEW_MS = 5_000;
const TICK_SAVE_MS = 1_000;

export class Session {
  private sandbox: Sandbox | null = null;
  meta!: GameMeta;
  private snap!: Snapshot;
  private conns = new Set<Conn>();
  private queue: Promise<unknown> = Promise.resolve();
  private timers: NodeJS.Timeout[] = [];
  private graceTimers = new Map<string, NodeJS.Timeout>();
  private turnTimer: NodeJS.Timeout | null = null;
  private sleepTimer: NodeJS.Timeout | null = null;
  private lastTickSave = 0;
  private stopped = false;
  private readonly players: Map<string, Player>;
  actionsHandled = 0;

  constructor(
    readonly cfg: SessionConfig,
    private readonly store: Store,
    private readonly registry: Registry,
    private readonly limits: Limits,
    private readonly workerId: string,
    private readonly onGone: (s: Session) => void,
  ) {
    this.players = new Map(cfg.players.map((p) => [p.userId, p]));
  }

  get id() { return this.cfg.id; }
  get status(): Status { return this.snap.status; }
  get connections() { return this.conns.size; }
  isPlayer(userId: string) { return this.players.has(userId); }

  /** Claims the session, loads (or sets up) the state and starts its timers. */
  async wake(): Promise<void> {
    if (!(await this.store.claim(this.id, this.workerId, OWNER_TTL_MS))) throw new OwnerBusy();
    try {
      const existing = await this.store.loadSnapshot(this.id);
      if (existing && existing.status !== 'RUNNING') {
        this.snap = existing; // finished: only answers reconnects with the result
        return;
      }
      this.sandbox = await Sandbox.create(this.cfg.logic.code, this.cfg.logic.sha256, this.limits);
      this.meta = await this.sandbox.meta();
      if (existing) {
        this.snap = existing;
        // Views live only in memory: rebuild them so hidden-info games can welcome players at once.
        if (this.meta.hasView) this.views = (await this.call('peek', {}))?.views ?? null;
      } else {
        await this.setup();
      }
      this.timers.push(setInterval(() => void this.renewOwner(), OWNER_RENEW_MS));
      this.timers.push(setInterval(() => this.enqueue(() => this.checkLimits()), 30_000));
      if (this.meta.tickHz > 0) {
        const every = Math.max(33, Math.round(1000 / Math.min(this.meta.tickHz, 30)));
        this.timers.push(setInterval(() => this.enqueue(() => this.tick(every)), every));
      }
      await this.enqueue(() => this.checkLimits());
      await this.enqueue(() => this.catchUpTurn());
    } catch (e) {
      await this.dispose();
      if (e instanceof SandboxError) {
        // A bundle that can't even load ends the session; the dev portal shows why.
        const snap = await this.store.loadSnapshot(this.id);
        if (!snap || snap.status === 'RUNNING') {
          this.snap = snap ?? this.emptySnapshot();
          await this.finishNow('ABANDONED', null, `logic_${e.kind}`);
        }
        return;
      }
      throw e;
    }
  }

  private emptySnapshot(): Snapshot {
    const now = Date.now();
    return {
      status: 'RUNNING', seq: 0, state: null, rng: seedToUint32(this.cfg.seed), startedAt: now, updatedAt: now,
      strikes: 0, turn: null, result: null, persisted: this.cfg.persisted, left: [],
    };
  }

  private async setup() {
    const n = this.cfg.players.length;
    this.snap = this.emptySnapshot();
    if ((this.meta.minPlayers && n < this.meta.minPlayers) || (this.meta.maxPlayers && n > this.meta.maxPlayers)) {
      await this.finishNow('ABANDONED', null, 'wrong_player_count');
      return;
    }
    const persisted = { players: { ...this.cfg.persisted.players }, dm: this.cfg.persisted.dm ?? {} };
    for (const p of this.cfg.players) if (persisted.players[p.userId] == null) persisted.players[p.userId] = {};
    this.snap.persisted = persisted;
    const out = await this.call('setup', { players: this.cfg.players.map(publicPlayer) });
    if (!out) return;
    this.apply(out);
    await this.store.commit(this.id, this.snap, null, null);
    void this.registry.started(this.id, this.snap.startedAt);
    if (this.snap.status === 'RUNNING' && out.over) await this.handleOver(out.over);
  }

  // ---------- connections ----------

  /** Adds a socket and sends it the current state (plus what it missed, if we still have it). */
  async attach(conn: Conn, resumeFrom: number | null) {
    const mine = [...this.conns].filter((c) => c.userId === conn.userId);
    if (mine.length >= this.limits.socketsPerUser) mine[0]?.close(4005, 'replaced');
    this.conns.add(conn);
    this.cancelSleep();
    const g = this.graceTimers.get(conn.userId);
    if (g) { clearTimeout(g); this.graceTimers.delete(conn.userId); }
    await this.enqueue(async () => {
      let missed = resumeFrom !== null && resumeFrom < this.snap.seq
        ? (await this.store.readLog(this.id, resumeFrom))?.slice(-100) ?? null
        : [];
      // Games with hidden information never show raw action payloads to other players.
      if (missed && this.meta?.hasView) missed = missed.map((e) => ({ ...e, p: e.by === conn.userId ? e.p : undefined }));
      conn.send({
        t: 'welcome',
        me: conn.userId,
        role: conn.role,
        seq: this.snap.seq,
        status: this.snap.status,
        s: this.viewFor(conn),
        players: this.playerList(),
        turn: this.snap.turn,
        result: this.snap.result,
        missed,
        serverTime: Date.now(),
      });
      this.broadcastPlayers();
    });
  }

  detach(conn: Conn) {
    if (!this.conns.delete(conn)) return;
    const stillHere = [...this.conns].some((c) => c.userId === conn.userId);
    if (!stillHere && conn.role === 'player' && this.snap?.status === 'RUNNING' && this.cfg.reconnectGraceSec > 0) {
      const t = setTimeout(() => {
        this.graceTimers.delete(conn.userId);
        this.enqueue(() => this.playerGone(conn.userId, 'timeout'));
      }, this.limits.awayMs + this.cfg.reconnectGraceSec * 1000);
      this.graceTimers.set(conn.userId, t);
    }
    this.broadcastPlayers();
    if (this.conns.size === 0) this.scheduleSleep();
  }

  /** One action from a player. Answers {t:'ok'} / {t:'no'} to that socket. */
  act(conn: Conn, id: string, name: string, payload: unknown) {
    return this.enqueue(async () => {
      if (this.stopped || this.snap.status !== 'RUNNING' || !this.sandbox) return conn.send({ t: 'no', id, err: 'session_over' });
      if (conn.role !== 'player' || this.snap.left.includes(conn.userId)) return conn.send({ t: 'no', id, err: 'not_a_player' });
      const seen = await this.store.seenAction(this.id, conn.userId, id);
      if (seen !== null) return conn.send({ t: 'ok', id, seq: seen, dup: true });
      const out = await this.call('action', { name, payload, playerId: conn.userId });
      if (!out) return conn.send({ t: 'no', id, err: 'logic_error' });
      if (out.rejected) return conn.send({ t: 'no', id, err: out.rejected });
      const entry = this.nextEntry(conn.userId, name, payload);
      if (!this.apply(out)) return conn.send({ t: 'no', id, err: 'state_too_large' });
      await this.store.commit(this.id, this.snap, entry, { userId: conn.userId, id });
      this.actionsHandled++;
      conn.send({ t: 'ok', id, seq: entry.seq });
      this.broadcastUpdate('u', entry);
      if (out.over) await this.handleOver(out.over);
    });
  }

  // ---------- game loop pieces ----------

  private async tick(dtMs: number) {
    if (this.snap.status !== 'RUNNING' || !this.sandbox) return;
    const out = await this.call('tick', { dt: dtMs });
    if (!out || out.rejected) return;
    if (!this.apply(out)) return;
    // Ticks are not logged one by one (30/s); the state is saved at most once a second.
    const now = Date.now();
    if (now - this.lastTickSave >= TICK_SAVE_MS || out.over) {
      this.lastTickSave = now;
      await this.store.commit(this.id, this.snap, null, null);
    }
    this.broadcastUpdate('tick', null);
    if (out.over) await this.handleOver(out.over);
  }

  private async catchUpTurn() {
    // After a sleep or restart: apply every turn timeout that passed meanwhile.
    for (let i = 0; i < 100 && this.snap.status === 'RUNNING' && this.snap.turn && this.snap.turn.deadline <= Date.now(); i++) {
      await this.turnTimeout(this.snap.turn.userId);
    }
    this.armTurnTimer();
  }

  private armTurnTimer() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    const t = this.snap.turn;
    if (!t || this.snap.status !== 'RUNNING' || this.stopped) return;
    this.turnTimer = setTimeout(() => this.enqueue(async () => {
      if (this.snap.turn && this.snap.turn.deadline <= Date.now()) await this.turnTimeout(this.snap.turn.userId);
      this.armTurnTimer();
    }), Math.max(0, t.deadline - Date.now()));
  }

  private async turnTimeout(userId: string) {
    const out = await this.call('timeout', { playerId: userId });
    if (!out || out.rejected) { this.snap.turn = null; return; }
    const entry = this.nextEntry(null, 'turn_timeout', { userId });
    if (!this.apply(out)) return;
    await this.store.commit(this.id, this.snap, entry, null);
    this.broadcastUpdate('u', entry);
    if (out.over) await this.handleOver(out.over);
  }

  private async playerGone(userId: string, reason: 'timeout' | 'quit') {
    if (this.snap.status !== 'RUNNING' || this.snap.left.includes(userId)) return;
    this.snap.left.push(userId);
    if (this.meta.handlesLeave) {
      const out = await this.call('left', { player: publicPlayer(this.players.get(userId)!), reason });
      const entry = this.nextEntry(null, 'player_left', { userId, reason });
      if (out && !out.rejected && this.apply(out)) {
        await this.store.commit(this.id, this.snap, entry, null);
        this.broadcastUpdate('u', entry);
        if (out.over) return this.handleOver(out.over);
      }
    } else {
      await this.store.commit(this.id, this.snap, this.nextEntry(null, 'player_left', { userId, reason }), null);
    }
    this.broadcastPlayers();
    const remaining = this.cfg.players.filter((p) => !this.snap.left.includes(p.userId));
    if (!this.meta.handlesLeave && remaining.length < Math.max(2, this.meta.minPlayers || 2)) {
      // Default rule (spec §8.4): competitive → whoever left loses; otherwise nobody's record changes.
      if (this.cfg.mode === 'competitive' && remaining.length > 0) {
        const placements: Placement[] = [
          ...remaining.map((p) => ({ userId: p.userId, place: 1 })),
          ...this.snap.left.map((u) => ({ userId: u, place: 2 })),
        ];
        await this.finishNow('COMPLETED', { placements, draw: false }, 'forfeit');
      } else {
        await this.finishNow('ABANDONED', null, 'players_left');
      }
    }
  }

  private async checkLimits() {
    if (this.snap.status !== 'RUNNING') return;
    const now = Date.now();
    if (now - this.snap.startedAt > this.cfg.maxDurationSec * 1000) return this.finishNow('ABANDONED', null, 'max_duration');
    if (now - this.snap.updatedAt > this.cfg.idleTimeoutSec * 1000) return this.finishNow('ABANDONED', null, 'idle');
  }

  // ---------- results ----------

  private async handleOver(over: unknown) {
    const result = normalizeResult(over, this.cfg.players);
    if (!result) return this.finishNow('ABANDONED', null, 'invalid_result');
    return this.finishNow('COMPLETED', result, 'game_over');
  }

  private async finishNow(status: Exclude<Status, 'RUNNING'>, result: Result | null, reason: string) {
    if (this.snap.status !== 'RUNNING') return;
    this.snap.status = status;
    this.snap.result = result;
    this.snap.turn = null;
    this.snap.endReason = reason;
    this.snap.updatedAt = Date.now();
    if (this.turnTimer) clearTimeout(this.turnTimer);
    await this.store.commit(this.id, this.snap, null, null);
    for (const c of this.conns) c.send({ t: 'end', status, result, reason, seq: this.snap.seq });
    const logEntries = (await this.store.readLog(this.id, 0)) ?? [];
    await this.store.expire(this.id, this.limits.finishedTtlSec);
    log.info('session finished', { ses: this.id, app: this.cfg.appId, status, reason, actions: this.snap.seq });
    void this.registry.finished(this.id, {
      status, result, reason, finalState: this.snap.state, log: logEntries, persisted: this.snap.persisted,
      startedAt: this.snap.startedAt, endedAt: this.snap.updatedAt, actions: this.snap.seq,
    });
    this.sandbox?.dispose();
    this.sandbox = null;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    // Leave sockets open a moment so the result arrives, then let clients go.
    setTimeout(() => { for (const c of this.conns) c.close(1000, 'game_over'); }, 2000).unref();
    this.scheduleSleep();
  }

  // ---------- sandbox plumbing ----------

  /** Runs a sandbox call with the current state. Returns null after a crash (session already ended). */
  private async call(kind: string, extra: Record<string, unknown>): Promise<CallOutput | null> {
    if (!this.sandbox) return null;
    try {
      const out = await this.sandbox.run(kind, {
        state: this.snap.state, rng: this.snap.rng, persisted: this.snap.persisted, now: Date.now(),
        mode: this.cfg.mode, flags: this.cfg.flags, viewers: this.viewers(), ...extra,
      });
      if (this.sandbox.lastCpuMs > this.limits.softCpuMs) await this.strike('slow', this.sandbox.lastCpuMs);
      return out;
    } catch (e) {
      const err = e instanceof SandboxError ? e : new SandboxError(String(e), 'crash');
      log.warn('logic error', { ses: this.id, app: this.cfg.appId, version: this.cfg.versionId, kind: err.kind, call: kind, msg: err.message });
      if (err.kind === 'timeout' && kind !== 'setup') {
        await this.strike('timeout', this.limits.hardCpuMs);
        return { rejected: 'logic_timeout' };
      }
      await this.finishNow('ABANDONED', null, `logic_${err.kind}`);
      return null;
    }
  }

  private async strike(why: string, ms: number) {
    this.snap.strikes++;
    log.debug('logic strike', { ses: this.id, why, ms: Math.round(ms), strikes: this.snap.strikes });
    if (this.snap.strikes > this.limits.maxStrikes) await this.finishNow('ABANDONED', null, 'logic_too_slow');
  }

  /** Takes a call's output into the snapshot. False if the state is over the size limit. */
  private apply(out: CallOutput): boolean {
    if (out.state !== undefined) {
      if (JSON.stringify(out.state).length > this.limits.maxStateBytes) {
        log.warn('state too large', { ses: this.id, app: this.cfg.appId });
        return false;
      }
      this.snap.state = out.state;
    }
    if (typeof out.rng === 'number') this.snap.rng = out.rng >>> 0;
    if (out.persisted) this.snap.persisted = out.persisted;
    this.views = out.views ?? null;
    const t = out.turn;
    const prev = this.snap.turn;
    this.snap.turn = t && this.players.has(t.userId)
      // Same player still on turn → keep the running deadline; new turn → fresh clock.
      ? { userId: t.userId, deadline: prev && prev.userId === t.userId ? prev.deadline : Date.now() + t.seconds * 1000 }
      : null;
    this.snap.updatedAt = Date.now();
    this.armTurnTimer();
    return true;
  }

  private views: Record<string, unknown> | null = null;

  private viewers(): (string | null)[] {
    const v: (string | null)[] = this.cfg.players.map((p) => p.userId);
    if (this.cfg.spectators) v.push(null);
    return v;
  }

  private viewFor(conn: Conn): unknown {
    if (!this.meta?.hasView) return this.snap.state;
    if (!this.views) return null; // a game with hidden info never sends the full state
    return conn.role === 'spectator' ? this.views[''] ?? null : this.views[conn.userId] ?? null;
  }

  private nextEntry(by: string | null, name: string, p: unknown): LogEntry {
    this.snap.seq++;
    return { seq: this.snap.seq, by, name, p, at: Date.now() };
  }

  private broadcastUpdate(t: 'u' | 'tick', entry: LogEntry | null) {
    for (const c of this.conns) {
      c.send(entry
        ? { t, seq: entry.seq, by: entry.by, name: entry.name, p: this.meta.hasView ? undefined : entry.p, s: this.viewFor(c), turn: this.snap.turn }
        : { t, seq: this.snap.seq, s: this.viewFor(c), turn: this.snap.turn });
    }
  }

  private playerList() {
    const online = new Set([...this.conns].map((c) => c.userId));
    return this.cfg.players.map((p) => ({ ...publicPlayer(p), connected: online.has(p.userId), left: this.snap?.left.includes(p.userId) ?? false }));
  }

  private broadcastPlayers() {
    const players = this.playerList();
    for (const c of this.conns) c.send({ t: 'players', players });
  }

  // ---------- lifecycle ----------

  private enqueue<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const run = this.queue.then(() => (this.stopped ? undefined : fn()));
    this.queue = run.catch((e) => log.error('session step failed', { ses: this.id, err: (e as Error).message }));
    return run;
  }

  private async renewOwner() {
    if (this.stopped) return;
    const ok = await this.store.renew(this.id, this.workerId, OWNER_TTL_MS).catch(() => false);
    if (!ok) {
      log.warn('lost session lock', { ses: this.id });
      for (const c of this.conns) c.close(4009, 'moved');
      await this.dispose(false);
    }
  }

  private scheduleSleep() {
    this.cancelSleep();
    this.sleepTimer = setTimeout(() => void this.sleep(), this.limits.sleepAfterMs);
    this.sleepTimer.unref();
  }

  private cancelSleep() {
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
  }

  /** Nobody here: drop the session from memory. The state is already in the store. */
  private async sleep() {
    if (this.conns.size > 0) return;
    await this.queue;
    await this.dispose();
  }

  /** Stops everything. Used by sleep, lost lock and shutdown. */
  async dispose(release = true) {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelSleep();
    for (const t of this.timers) clearInterval(t);
    for (const t of this.graceTimers.values()) clearTimeout(t);
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.sandbox?.dispose();
    this.sandbox = null;
    if (release) await this.store.release(this.id, this.workerId).catch(() => undefined);
    this.onGone(this);
  }

  /** Shutdown: tell clients to reconnect (another worker / the restarted one takes over). */
  async shutdown() {
    await this.queue;
    for (const c of this.conns) c.close(1012, 'restart');
    await this.dispose();
  }
}

function publicPlayer(p: Player) {
  return { userId: p.userId, seat: p.seat, displayName: p.displayName, avatarUrl: p.avatarUrl ?? null, color: p.color };
}

/** 128-bit seed string → uint32 RNG state (FNV-1a). */
export function seedToUint32(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/**
 * Checks what gameOver() returned. Only real players, unique, places ≥ 1, finite scores.
 * { draw: true } → everyone 1st. { placements, rest } → unlisted players get `rest`.
 */
export function normalizeResult(over: unknown, players: Player[]): Result | null {
  if (!over || typeof over !== 'object') return null;
  const o = over as { draw?: unknown; placements?: unknown; rest?: unknown };
  const ids = new Set(players.map((p) => p.userId));
  if (o.draw === true) return { draw: true, placements: players.map((p) => ({ userId: p.userId, place: 1 })) };
  if (!Array.isArray(o.placements) || o.placements.length === 0 || o.placements.length > players.length) return null;
  const seen = new Set<string>();
  const placements: Placement[] = [];
  for (const raw of o.placements) {
    const p = raw as { userId?: unknown; place?: unknown; score?: unknown };
    if (typeof p.userId !== 'string' || !ids.has(p.userId) || seen.has(p.userId)) return null;
    if (!Number.isInteger(p.place) || (p.place as number) < 1 || (p.place as number) > players.length) return null;
    if (p.score !== undefined && (typeof p.score !== 'number' || !Number.isFinite(p.score))) return null;
    seen.add(p.userId);
    placements.push({ userId: p.userId, place: p.place as number, ...(p.score !== undefined ? { score: p.score as number } : {}) });
  }
  const maxPlace = Math.max(...placements.map((p) => p.place));
  const rest = o.rest === undefined ? maxPlace + 1 : o.rest;
  if (!Number.isInteger(rest) || (rest as number) < 1 || (rest as number) > players.length) return null;
  for (const p of players) if (!seen.has(p.userId)) placements.push({ userId: p.userId, place: rest as number });
  return { placements, draw: false };
}
