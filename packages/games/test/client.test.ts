import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_LIMITS, DevRegistry, MemoryStore, SessionManager, createGameServer, devToken, parseDevToken, sha256,
  type SessionConfig,
} from '@vibes/game-runtime';
import { Vibes, GameActionError, type Change, type Context } from '../src';

process.env.LOG_SILENT = '1';
const code = readFileSync(join(__dirname, '..', '..', '..', 'examples', 'tictactoe', 'logic.js'), 'utf8');
type Board = { board: (string | null)[]; turn: string };
type TicTacToe = { setup(): Board; actions: { place(s: Board, cell: number, ctx: unknown): void } };

async function server() {
  const limits = { ...DEFAULT_LIMITS, awayMs: 20 };
  const registry = new DevRegistry();
  const sessions = new SessionManager(limits, 'w1', new MemoryStore(), registry);
  const srv = createGameServer({ sessions, limits, authenticate: parseDevToken });
  await new Promise<void>((r) => srv.http.listen(0, '127.0.0.1', () => r()));
  const cfg: SessionConfig = {
    id: randomUUID(), appId: 'app1', versionId: 'v1', dmId: 'dm1', mode: 'friendly', flags: {}, seed: 's',
    players: [{ userId: 'alice', seat: 0 }, { userId: 'bob', seat: 1 }], spectators: false,
    logic: { code, sha256: sha256(code) }, reconnectGraceSec: 0, idleTimeoutSec: 600, maxDurationSec: 3600,
    persisted: { players: {}, dm: {} },
  };
  registry.add(cfg);
  const ctx = (userId: string, tokenFor = userId): Context => ({
    sessionId: cfg.id, dmId: 'dm1', mode: 'friendly', flags: {}, me: { userId }, role: 'player',
    platform: 'dev', locale: 'en', theme: 'dark',
    play: { url: `ws://127.0.0.1:${srv.port()}/s/${cfg.id}`, token: devToken({ sessionId: cfg.id, userId: tokenFor, appId: 'app1', role: 'player' }) },
  });
  return { srv, sessions, cfg, ctx, async close() { await sessions.shutdown(); await srv.close(); } };
}

function player(context: Context) {
  const changes: Change<Board>[] = [];
  const conn: string[] = [];
  let notify: (() => void) | null = null;
  const game = Vibes.init<TicTacToe>({
    context, onChange: (c) => { changes.push(c); notify?.(); }, onConnection: (s, i) => conn.push(i?.code ? `${s}:${i.code}` : s),
  });
  const until = (pred: (c: Change<Board>) => boolean, ms = 3000) => new Promise<Change<Board>>((res, rej) => {
    const hit = changes.find(pred);
    if (hit) return res(hit);
    const t = setTimeout(() => rej(new Error('timeout: ' + JSON.stringify(changes.map((c) => c.event)))), ms);
    notify = () => { const h = changes.find(pred); if (h) { clearTimeout(t); notify = null; res(h); } };
  });
  return { game, changes, conn, until };
}

test('two players finish a game through the SDK only', async () => {
  const s = await server();
  try {
    const a = player(s.ctx('alice')), b = player(s.ctx('bob'));
    const w = await a.until((c) => c.event === 'welcome');
    await b.until((c) => c.event === 'welcome');
    const byId = { alice: a, bob: b } as Record<string, ReturnType<typeof player>>;
    const first = byId[w.state.turn]!, second = first === a ? b : a;
    await assert.rejects(second.game.actions.place(0), (e: GameActionError) => e.code === 'not_your_turn');
    for (const [p, cell] of [[first, 0], [second, 3], [first, 1], [second, 4], [first, 2]] as const) await p.game.actions.place(cell);
    const end = await a.until((c) => c.event === 'end');
    assert.equal(end.status, 'COMPLETED');
    assert.equal(end.result?.placements.find((p) => p.place === 1)?.userId, w.state.turn);
    await assert.rejects(b.game.actions.place(8), (e: GameActionError) => e.code === 'session_over');
    a.game.close(); b.game.close();
  } finally { await s.close(); }
});

test('reconnect: the SDK resumes by itself and an action sent while offline is applied once', async () => {
  const s = await server();
  try {
    const a = player(s.ctx('alice')), b = player(s.ctx('bob'));
    const w = await a.until((c) => c.event === 'welcome');
    await b.until((c) => c.event === 'welcome');
    const mover = w.state.turn === 'alice' ? a : b;
    // Drop every socket on the server (like a deploy), then act right away.
    const live = (s.sessions as unknown as { live: Map<string, { shutdown(): Promise<void> }> }).live;
    await Promise.all([...live.values()].map((x) => x.shutdown()));
    const r = await mover.game.actions.place(4);
    assert.equal(r.seq, 1);
    const u = await a.until((c) => c.event === 'action' && c.seq === 1, 5000);
    assert.equal(u.state.board.filter(Boolean).length, 1);
    assert.ok(mover.conn.includes('reconnecting'));
    a.game.close(); b.game.close();
  } finally { await s.close(); }
});

test('a refused token is final: no endless reconnect loop', async () => {
  const s = await server();
  try {
    const m = player(s.ctx('mallory'));
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(m.conn.filter((x) => x.startsWith('closed')), ['closed:4003']);
    assert.equal(m.conn.filter((x) => x === 'reconnecting').length, 0);
  } finally { await s.close(); }
});

test('server clock: time.now() follows the server', async () => {
  const s = await server();
  try {
    const a = player(s.ctx('alice'));
    await a.until((c) => c.event === 'welcome');
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(Math.abs(a.game.time.now() - Date.now()) < 100);
    a.game.close();
  } finally { await s.close(); }
});
