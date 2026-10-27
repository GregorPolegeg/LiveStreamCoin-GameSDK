/**
 * HTTP + WebSocket server around the runtime: WS /s/<sessionId> speaks the game
 * protocol (socket.ts), plus heartbeat. The production game server builds its own
 * on top of handleSocket (JWT auth, Redis, metrics); this one is for the CLI dev
 * server and tests.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Limits } from './limits';
import type { SessionManager } from './manager';
import { handleSocket, type Claims } from './socket';

const PATH = /^\/s\/([A-Za-z0-9_-]{1,64})$/;
const HEARTBEAT_MS = 15_000;

export interface GameHttpServer {
  http: http.Server;
  port(): number;
  close(): Promise<void>;
}

export function createGameServer(opts: {
  sessions: SessionManager;
  limits: Limits;
  authenticate(token: unknown): Claims | null;
  /** Other HTTP routes (the dev server serves the game files and the host page). */
  onRequest?: http.RequestListener;
}): GameHttpServer {
  const server = http.createServer(opts.onRequest ?? ((_req, res) => res.writeHead(404).end()));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  const alive = new WeakMap<WebSocket, boolean>();

  server.on('upgrade', (req, socket, head) => {
    const m = PATH.exec(new URL(req.url ?? '/', 'http://x').pathname);
    if (!m) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      handleSocket(ws, m[1]!, opts);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) { ws.terminate(); continue; }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    http: server,
    port: () => (server.address() as AddressInfo).port,
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/**
 * Dev tokens: `dev.<base64url JSON {ses, userId, app, role}>`. NO signature: only for
 * the local dev server and tests. The production game server never accepts them.
 */
export function devToken(c: Claims): string {
  return 'dev.' + Buffer.from(JSON.stringify({ ses: c.sessionId, userId: c.userId, app: c.appId, role: c.role })).toString('base64url');
}

export function parseDevToken(token: unknown): Claims | null {
  if (typeof token !== 'string' || !token.startsWith('dev.') || token.length > 2048) return null;
  try {
    const p = JSON.parse(Buffer.from(token.slice(4), 'base64url').toString('utf8'));
    if (typeof p.ses !== 'string' || typeof p.userId !== 'string' || typeof p.app !== 'string') return null;
    if (p.role !== 'player' && p.role !== 'spectator') return null;
    return { sessionId: p.ses, userId: p.userId, appId: p.app, role: p.role };
  } catch {
    return null;
  }
}
