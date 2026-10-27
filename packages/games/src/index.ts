/**
 * @vibes/games — the client SDK for a VIBES DM game.
 *
 *   import { Vibes } from '@vibes/games';
 *   import type game from '../logic';
 *
 *   const vibes = Vibes.init<typeof game>({
 *     onChange({ state, me, players, status }) { render(state, me); },
 *   });
 *   cell.onclick = () => vibes.actions.place(4).catch((e) => toast(e.code));
 *
 * This is all the networking a game writes. The SDK gets the session from the
 * VIBES host (app WebView or web iframe), connects to the game server, resumes
 * after drops, resends unconfirmed actions with the same id (applied once), and
 * keeps a server-synced clock.
 */

export type Mode = 'friendly' | 'competitive' | 'practice';
export type Status = 'connecting' | 'RUNNING' | 'COMPLETED' | 'ABANDONED';

export interface PlayerInfo {
  userId: string;
  seat: number;
  displayName?: string;
  avatarUrl?: string | null;
  color?: string;
  connected: boolean;
  left: boolean;
}

export interface Result {
  placements: { userId: string; place: number; score?: number }[];
  draw: boolean;
}

export interface Context {
  sessionId: string;
  dmId: string;
  mode: Mode;
  flags: Record<string, unknown>;
  me: { userId: string; displayName?: string; avatarUrl?: string | null; color?: string };
  role: 'player' | 'spectator';
  platform: 'ios' | 'android' | 'web' | 'dev';
  locale: string;
  theme: 'light' | 'dark';
  /** Where and how to connect. Given by the host, refreshed before the token expires. */
  play: { url: string; token: string };
}

export interface Change<S> {
  /** What happened: the first state, an action, a tick, a turn timeout, players changing, the end. */
  event: 'welcome' | 'action' | 'tick' | 'players' | 'end';
  state: S;
  me: string;
  players: PlayerInfo[];
  status: Status;
  seq: number;
  /** For event 'action': who did what (payload hidden in games with view()). */
  action?: { by: string | null; name: string; payload?: unknown };
  turn: { userId: string; deadline: number } | null;
  result: Result | null;
  endReason?: string;
}

export class GameActionError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Action payload types from the game's logic (typeof game) → typed vibes.actions.x(payload). */
type PayloadsOf<G> = G extends { actions: infer Acts }
  ? { [K in keyof Acts]: Acts[K] extends (s: any, payload: infer A, ctx: any) => any ? A : never }
  : Record<string, unknown>;
type StateOf<G> = G extends { setup(...a: any[]): infer S } ? S : unknown;

export type Actions<G> = { [K in keyof PayloadsOf<G>]: (payload: PayloadsOf<G>[K]) => Promise<{ seq: number }> };

export interface InitOptions<S> {
  onChange(change: Change<S>): void;
  /** Connection problems the game may want to show ("Reconnecting…"). */
  onConnection?(state: 'connecting' | 'open' | 'reconnecting' | 'closed', info?: { code?: number; reason?: string }): void;
  /** Called when the host pauses the game (app in background) and resumes it. */
  onPause?(): void;
  onResume?(): void;
  /**
   * Skip the host and connect directly (tests, custom dev setups). In the VIBES app and
   * on vibes.stream the host provides the context; never put a real token in your code.
   */
  context?: Context;
  /** Host origins allowed to talk to this game (web). Defaults to vibes.stream; localhost hosts are allowed when the game itself runs on localhost. */
  hostOrigins?: string[];
  /** Node tests: a WebSocket implementation (e.g. the `ws` package). */
  WebSocket?: typeof WebSocket;
}

export interface Game<G> {
  readonly actions: Actions<G>;
  readonly context: Context | null;
  readonly state: StateOf<G> | null;
  readonly players: PlayerInfo[];
  readonly status: Status;
  /** Server time (ms), synced with ping/pong. Use it for countdowns. */
  readonly time: { now(): number };
  /** Leave the game (closes the socket and tells the host). */
  close(): void;
}

export const HOST_ORIGINS = ['https://vibes.stream', 'https://www.vibes.stream'];

const FATAL = new Set([4001, 4002, 4003, 4004]);
const PING_MS = 10_000;

interface Pending { name: string; p: unknown; resolve: (r: { seq: number }) => void; reject: (e: Error) => void }

class Client<G> implements Game<G> {
  context: Context | null = null;
  state: StateOf<G> | null = null;
  players: PlayerInfo[] = [];
  status: Status = 'connecting';
  readonly actions: Actions<G>;
  readonly time = { now: () => Date.now() + this.offset };

  private ws: WebSocket | null = null;
  private seq = -1;
  private pending = new Map<string, Pending>();
  private counter = 0;
  private readonly idPrefix = Math.random().toString(36).slice(2, 10);
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private offset = 0;
  private bestRtt = Infinity;
  private closedByUs = false;
  private hostOrigin: string | null = null;
  private turn: Change<unknown>['turn'] = null;
  private result: Result | null = null;
  private WS: typeof WebSocket;

  constructor(private readonly opts: InitOptions<StateOf<G>>) {
    const WS = opts.WebSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WS) throw new Error('No WebSocket available (pass options.WebSocket in Node)');
    this.WS = WS;
    this.actions = new Proxy({} as Actions<G>, {
      get: (_t, name) => (typeof name === 'string' ? (p: unknown) => this.act(name, p) : undefined),
    });
    if (opts.context) this.setContext(opts.context);
    else this.listenToHost();
  }

  // ---------- host bridge ----------

  private listenToHost() {
    const w = globalThis as unknown as Window & { VibesHost?: { postMessage(m: string): void }; __vibesReceive?: (json: string) => void };
    const allowed = new Set(this.opts.hostOrigins ?? HOST_ORIGINS);
    const onLocalhost = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    const allow = (origin: string) => allowed.has(origin) || (onLocalhost && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
    try {
      const ref = typeof document !== 'undefined' && document.referrer ? new URL(document.referrer).origin : null;
      if (ref && allow(ref)) this.hostOrigin = ref;
    } catch { /* no referrer */ }

    const receive = (json: string) => {
      let m: { vibes?: number; type?: string; context?: Context };
      try { m = JSON.parse(json); } catch { return; }
      if (m?.vibes !== 1) return;
      if (m.type === 'context' && m.context) this.setContext(m.context);
      else if (m.type === 'pause') this.opts.onPause?.();
      else if (m.type === 'resume') { this.opts.onResume?.(); this.reconnectNow(); }
    };
    // App (Flutter WebView): the host calls window.__vibesReceive(json).
    w.__vibesReceive = receive;
    // Web (iframe): only our host, only from the parent window.
    w.addEventListener?.('message', (e: MessageEvent) => {
      if (e.source !== w.parent || !this.hostOrigin || e.origin !== this.hostOrigin) return;
      if (typeof e.data === 'string') receive(e.data);
    });
    this.toHost({ type: 'ready', sdk: 'games/0.1' });
    w.addEventListener?.('online', () => this.reconnectNow());
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.reconnectNow(); });
    }
  }

  private toHost(msg: Record<string, unknown>) {
    const w = globalThis as unknown as Window & { VibesHost?: { postMessage(m: string): void } };
    const text = JSON.stringify({ vibes: 1, ...msg });
    if (w.VibesHost) w.VibesHost.postMessage(text);
    else if (w.parent && w.parent !== w && this.hostOrigin) w.parent.postMessage(text, this.hostOrigin);
  }

  private setContext(ctx: Context) {
    const first = !this.context;
    const sameSession = this.context?.sessionId === ctx.sessionId;
    this.context = ctx; // a refreshed token is used on the next (re)connect
    if (first || !sameSession) {
      if (!sameSession && !first) { this.seq = -1; this.closeSocket(); }
      this.connect();
    }
  }

  // ---------- socket ----------

  private connect() {
    if (!this.context || this.closedByUs || this.isEnded()) return;
    if (this.ws && (this.ws.readyState === this.WS.OPEN || this.ws.readyState === this.WS.CONNECTING)) return;
    this.opts.onConnection?.(this.attempts === 0 ? 'connecting' : 'reconnecting');
    const ws = new this.WS(this.context.play.url);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'auth', token: this.context!.play.token, ...(this.seq >= 0 ? { resume: this.seq } : {}) }));
    };
    ws.onmessage = (ev: MessageEvent) => this.onFrame(typeof ev.data === 'string' ? ev.data : String(ev.data));
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPing();
      if (this.closedByUs || this.isEnded()) return this.opts.onConnection?.('closed', { code: ev.code, reason: ev.reason });
      if (FATAL.has(ev.code)) {
        this.opts.onConnection?.('closed', { code: ev.code, reason: ev.reason });
        return this.failPending('connection_refused');
      }
      this.scheduleReconnect(ev.code === 4009 || ev.code === 1012);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private scheduleReconnect(fast: boolean) {
    if (this.retryTimer) return;
    this.opts.onConnection?.('reconnecting');
    const base = fast ? 100 : Math.min(500 * 2 ** this.attempts, 5000);
    this.attempts++;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, base + Math.random() * 250);
  }

  private reconnectNow() {
    if (this.ws || this.closedByUs || this.isEnded() || !this.context) return;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.connect();
  }

  private onFrame(raw: string) {
    let f: any;
    try { f = JSON.parse(raw); } catch { return; }
    switch (f.t) {
      case 'welcome': {
        this.attempts = 0;
        this.opts.onConnection?.('open');
        this.seq = f.seq; this.state = f.s; this.players = f.players; this.status = f.status;
        this.turn = f.turn ?? null; this.result = f.result ?? null;
        this.emit('welcome');
        this.startPing();
        // Resend what the server never confirmed, same ids: it applies each one once.
        for (const [id, a] of this.pending) this.send({ t: 'act', id, name: a.name, p: a.p });
        if (this.isEnded()) this.failPending('session_over');
        return;
      }
      case 'u':
      case 'tick':
        if (typeof f.seq === 'number') this.seq = Math.max(this.seq, f.seq);
        this.state = f.s; this.turn = f.turn ?? null;
        this.emit(f.t === 'u' ? 'action' : 'tick', f.t === 'u' ? { by: f.by, name: f.name, payload: f.p } : undefined);
        return;
      case 'players':
        this.players = f.players;
        this.emit('players');
        return;
      case 'ok':
        this.pending.get(f.id)?.resolve({ seq: f.seq });
        this.pending.delete(f.id);
        return;
      case 'no':
        this.pending.get(f.id)?.reject(new GameActionError(f.err));
        this.pending.delete(f.id);
        return;
      case 'end':
        this.status = f.status; this.result = f.result ?? null; this.turn = null;
        this.emit('end', undefined, f.reason);
        this.failPending('session_over');
        return;
      case 'pong': {
        if (typeof f.c !== 'number' || typeof f.s !== 'number') return;
        const rtt = Date.now() - f.c;
        // Keep the offset from the fastest round trip seen (least network noise).
        if (rtt <= this.bestRtt * 1.5) { this.bestRtt = Math.min(this.bestRtt, rtt); this.offset = f.s - (f.c + rtt / 2); }
        return;
      }
    }
  }

  private emit(event: Change<unknown>['event'], action?: Change<unknown>['action'], endReason?: string) {
    this.opts.onChange({
      event, state: this.state as StateOf<G>, me: this.context?.me.userId ?? '', players: this.players,
      status: this.status, seq: this.seq, action, turn: this.turn, result: this.result, endReason,
    });
  }

  // ---------- actions ----------

  private act(name: string, p: unknown): Promise<{ seq: number }> {
    if (this.isEnded()) return Promise.reject(new GameActionError('session_over'));
    const id = `${this.idPrefix}-${++this.counter}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { name, p: p ?? null, resolve, reject });
      // Not connected yet / reconnecting: it goes out right after the next welcome.
      if (this.ws && this.ws.readyState === this.WS.OPEN && this.seq >= 0) this.send({ t: 'act', id, name, p: p ?? null });
    });
  }

  private send(f: object) {
    if (this.ws && this.ws.readyState === this.WS.OPEN) this.ws.send(JSON.stringify(f));
  }

  private failPending(code: string) {
    for (const a of this.pending.values()) a.reject(new GameActionError(code));
    this.pending.clear();
  }

  private isEnded() { return this.status === 'COMPLETED' || this.status === 'ABANDONED'; }

  private startPing() {
    this.stopPing();
    const ping = () => this.send({ t: 'ping', c: Date.now() });
    ping();
    this.pingTimer = setInterval(ping, PING_MS);
  }

  private stopPing() { if (this.pingTimer) clearInterval(this.pingTimer); this.pingTimer = null; }

  private closeSocket() {
    const ws = this.ws;
    this.ws = null;
    this.stopPing();
    ws?.close(1000, 'bye');
  }

  close() {
    this.closedByUs = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.closeSocket();
    this.failPending('closed');
    this.toHost({ type: 'close' });
  }
}

export const Vibes = {
  /** Start the game client. Call once. G = typeof your game logic (for typed actions and state). */
  init<G = unknown>(options: InitOptions<StateOf<G>>): Game<G> {
    return new Client<G>(options);
  },
};
