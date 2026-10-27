import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';
import {
  DEFAULT_LIMITS, DevRegistry, MemoryStore, SessionManager, createGameServer, devToken, parseDevToken, sha256,
  type Limits, type SessionConfig,
} from '../src';

process.env.LOG_SILENT = '1';

export function token(ses: string, userId: string, opts: { role?: 'player' | 'spectator'; app?: string } = {}) {
  return devToken({ sessionId: ses, userId, appId: opts.app ?? 'app1', role: opts.role ?? 'player' });
}

export const tictactoe = readFileSync(join(__dirname, '..', '..', '..', 'examples', 'tictactoe', 'logic.js'), 'utf8');

export function session(code: string, over: Partial<SessionConfig> = {}): SessionConfig {
  return {
    id: randomUUID(), appId: 'app1', versionId: 'v1', dmId: 'dm1', mode: 'friendly', flags: {}, seed: 'seed-1',
    players: [{ userId: 'alice', seat: 0, displayName: 'Alice' }, { userId: 'bob', seat: 1, displayName: 'Bob' }],
    spectators: false, logic: { code, sha256: sha256(code) }, reconnectGraceSec: 0, idleTimeoutSec: 600,
    maxDurationSec: 3600, persisted: { players: {}, dm: {} }, ...over,
  };
}

export async function startServer(limits: Partial<Limits> = {}) {
  const lim: Limits = { ...DEFAULT_LIMITS, awayMs: 20, ...limits };
  const store = new MemoryStore(lim.logLength);
  const registry = new DevRegistry();
  const sessions = new SessionManager(lim, 'test-worker', store, registry);
  const server = createGameServer({ sessions, limits: lim, authenticate: parseDevToken });
  await new Promise<void>((r) => server.http.listen(0, '127.0.0.1', () => r()));
  const port = server.port();
  return {
    limits: lim, store, registry, sessions, port,
    async close() { await sessions.shutdown(); await server.close(); },
  };
}

type Frame = Record<string, any>;

/** A test client that records every frame and can wait for one. */
export class Client {
  frames: Frame[] = [];
  closed: { code: number; reason: string } | null = null;
  private ws: WebSocket;
  private waiters: { pred: (f: Frame) => boolean; res: (f: Frame) => void; from: number }[] = [];
  private n = 0;
  readonly open: Promise<void>;

  constructor(port: number, ses: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/s/${ses}`);
    this.open = new Promise((r, j) => { this.ws.once('open', () => r()); this.ws.once('error', j); });
    this.ws.on('message', (d) => {
      const f = JSON.parse(d.toString()) as Frame;
      this.frames.push(f);
      this.waiters = this.waiters.filter((w) => { if (w.pred(f)) { w.res(f); return false; } return true; });
    });
    this.ws.on('close', (code, reason) => { this.closed = { code, reason: reason.toString() }; });
  }

  static async connect(port: number, ses: string, tok: string, resume?: number) {
    const c = new Client(port, ses);
    await c.open;
    c.send({ t: 'auth', token: tok, ...(resume !== undefined ? { resume } : {}) });
    return c;
  }

  send(f: Frame) { this.ws.send(JSON.stringify(f)); }

  act(name: string, p: unknown, id = `a${++this.n}`) { this.send({ t: 'act', id, name, p }); return id; }

  wait(pred: (f: Frame) => boolean, ms = 3000): Promise<Frame> {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout waiting; got ${JSON.stringify(this.frames.slice(-5))}`)), ms);
      this.waiters.push({ pred, from: this.frames.length, res: (f) => { clearTimeout(t); res(f); } });
    });
  }

  /** Waits for the reply to action id (ok or no). */
  reply(id: string) { return this.wait((f) => (f.t === 'ok' || f.t === 'no') && f.id === id); }

  closedWith(ms = 3000): Promise<{ code: number; reason: string }> {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('not closed')), ms);
      this.ws.once('close', (code, reason) => { clearTimeout(t); res({ code, reason: reason.toString() }); });
    });
  }

  close() { this.ws.close(); }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
