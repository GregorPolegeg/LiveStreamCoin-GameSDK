/**
 * The game protocol on one WebSocket (spec §8.3), shared by the production game
 * server and the local dev server. Only authentication differs: each server
 * passes its own `authenticate` (JWT in production, a plain dev token locally).
 *
 * Per socket: first frame must be auth (within 5 s), frames are handled strictly
 * in order, size and rate limits, close codes the SDK understands.
 */
import { WebSocket, type RawData } from 'ws';
import type { Limits } from './limits';
import { log } from './log';
import type { SessionManager } from './manager';
import { OwnerBusy, type Conn, type Session } from './session';

export interface Claims {
  userId: string;
  sessionId: string;
  appId: string;
  role: 'player' | 'spectator';
}

export interface SocketOptions {
  sessions: SessionManager;
  limits: Limits;
  /** Token → claims, or null to refuse (close 4003). */
  authenticate(token: unknown): Claims | null;
}

export const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const AUTH_TIMEOUT_MS = 5000;

class Bucket {
  private tokens: number;
  private at = Date.now();
  constructor(private readonly rate: number, private readonly burst: number) { this.tokens = burst; }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Runs the protocol on an accepted socket for session `sessionId`. */
export function handleSocket(ws: WebSocket, sessionId: string, opts: SocketOptions) {
  const { sessions, limits } = opts;
  let session: Session | null = null;
  let conn: Conn | null = null;
  const actions = new Bucket(limits.actionsPerSec, limits.actionsBurst);
  const frames = new Bucket(limits.actionsPerSec * 3, limits.actionsBurst * 3);
  let violations = 0;
  const send = (f: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f)); };
  const authTimer = setTimeout(() => ws.close(4001, 'auth_timeout'), AUTH_TIMEOUT_MS);

  const violate = (code: string) => {
    send({ t: 'error', code });
    if (++violations >= 10) ws.close(4008, 'rate_limited');
  };

  // Frames of one socket are handled strictly one after another (auth first, then actions in order).
  let chain: Promise<void> = Promise.resolve();
  ws.on('message', (raw, isBinary) => {
    chain = chain.then(() => onFrame(raw, isBinary)).catch((e) => {
      log.error('frame failed', { ses: sessionId, err: (e as Error).message });
    });
  });

  const onFrame = async (raw: RawData, isBinary: boolean): Promise<void> => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (isBinary) return ws.close(4002, 'binary_not_allowed');
    if (!frames.take()) return violate('rate_limited');
    let f: Record<string, unknown>;
    try { f = JSON.parse(raw.toString()); } catch { return violate('bad_json'); }
    if (!f || typeof f !== 'object') return violate('bad_frame');

    if (!conn) {
      if (f.t !== 'auth') return ws.close(4001, 'auth_first');
      const claims = opts.authenticate(f.token);
      if (!claims || claims.sessionId !== sessionId) return ws.close(4003, 'bad_token');
      clearTimeout(authTimer);
      try {
        session = await sessions.get(sessionId);
      } catch (e) {
        if (e instanceof OwnerBusy) return ws.close(1013, 'busy_retry');
        log.error('session load failed', { ses: sessionId, err: (e as Error).message });
        return ws.close(1011, 'unavailable');
      }
      if (!session || session.cfg.appId !== claims.appId) return ws.close(4004, 'unknown_session');
      // A "player" token from someone not in this game (they joined in VIBES just after it was set up):
      // they watch when the game allows it, and VIBES puts them in the next game.
      let role = claims.role;
      if (role === 'player' && !session.isPlayer(claims.userId)) {
        if (!session.cfg.spectators) return ws.close(4003, 'not_a_player');
        role = 'spectator';
      }
      if (role === 'spectator' && !session.cfg.spectators) return ws.close(4003, 'no_spectators');
      if (ws.readyState !== WebSocket.OPEN) return;
      conn = { userId: claims.userId, role, send, close: (code, reason) => ws.close(code, reason) };
      const resume = Number.isInteger(f.resume) && (f.resume as number) >= 0 ? (f.resume as number) : null;
      await session.attach(conn, resume);
      return;
    }

    switch (f.t) {
      case 'act': {
        if (typeof f.id !== 'string' || !ID.test(f.id) || typeof f.name !== 'string' || !NAME.test(f.name)) return violate('bad_action');
        if (JSON.stringify(f.p ?? null).length > limits.maxPayloadBytes) return violate('payload_too_large');
        if (!actions.take()) return send({ t: 'no', id: f.id, err: 'rate_limited' });
        await session!.act(conn, f.id, f.name, f.p ?? null);
        return;
      }
      case 'ping':
        return send({ t: 'pong', c: typeof f.c === 'number' ? f.c : null, s: Date.now() });
      default:
        return violate('unknown_frame');
    }
  };

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (session && conn) session.detach(conn);
  });
  ws.on('error', () => ws.terminate());
}
