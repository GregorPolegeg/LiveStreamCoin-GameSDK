/**
 * `vibes-games dev`: the same runtime VIBES runs (sandbox + session engine) on one local port.
 *
 *   /             host page: one iframe per player, each given its Context like the VIBES host
 *   /game/        dist/client
 *   /s/<id>       game WebSocket (runtime createGameServer, dev tokens)
 *   /__dev/...    new session, drop a player's connection, live reload events
 */
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'fs';
import type http from 'http';
import { extname, join, normalize, relative, resolve, sep } from 'path';
import {
  DEFAULT_LIMITS, DevRegistry, MemoryStore, SessionManager, createGameServer, devToken, parseDevToken, setLogger,
  type Conn, type Outcome, type Session, type SessionConfig,
} from '@vibes/game-runtime';
import { buildClient, buildLogic, type ClientBuild, type LogicBuild } from './build';
import { PLAYER_NAMES } from './fuzz';
import { hostPage } from './host-page';
import { loadProject, type Mode, type Project } from './manifest';
import { c, CliError } from './util';

export interface DevOptions { players?: number; port: number; host: string; verbose?: boolean }

interface Current { sessionId: string; mode: Mode; players: { userId: string; displayName: string; token: string }[] }

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};

/** Keeps the session's connections reachable so /__dev/drop can close them. */
class DevSessions extends SessionManager {
  private patched = new WeakSet<Session>();
  constructor(limits: typeof DEFAULT_LIMITS, store: MemoryStore, registry: DevRegistry, private readonly hook: (s: Session) => void) {
    super(limits, 'dev', store, registry);
  }
  override async get(id: string) {
    const s = await super.get(id);
    if (s && !this.patched.has(s)) { this.patched.add(s); this.hook(s); }
    return s;
  }
}

export async function dev(dir: string, opts: DevOptions): Promise<{ close(): Promise<void>; port: number }> {
  let project: Project = loadProject(dir);
  installLogger(!!opts.verbose);
  const say = (s: string) => process.stdout.write(s + '\n');

  let logic: LogicBuild | null = null;
  let client: ClientBuild | null = null;
  let logicError: string | null = null;
  let clientError: string | null = null;
  const buildError = () => logicError ?? clientError;
  let current: Current | null = null;
  let counter = 0;
  let lastPersisted: SessionConfig['persisted'] = { players: {}, dm: {} };
  const clamp = (n: number) => Math.min(project.manifest.players.max, Math.max(project.manifest.players.min, n));
  let playerCount = clamp(opts.players ?? project.manifest.players.min);

  const limits = { ...DEFAULT_LIMITS };
  const store = new MemoryStore(limits.logLength);
  const registry = new (class extends DevRegistry {
    override async finished(id: string, outcome: Outcome) {
      await super.finished(id, outcome);
      lastPersisted = outcome.persisted as SessionConfig['persisted'];
      const places = outcome.result?.placements.map((p) => `${p.userId} #${p.place}`).join(', ');
      say(`${c.cyan('game')} ${id} ended: ${outcome.status} (${outcome.reason})${outcome.result?.draw ? ', draw' : places ? `, ${places}` : ''}`);
    }
  })();

  // Per session: the open connections, and users kept offline by "Drop connection".
  const conns = new Map<string, Set<Conn>>();
  const offline = new Map<string, number>();
  const sessions = new DevSessions(limits, store, registry, (s) => {
    const attach = s.attach.bind(s);
    const detach = s.detach.bind(s);
    s.attach = async (conn: Conn, resume: number | null) => {
      if ((offline.get(`${s.id}:${conn.userId}`) ?? 0) > Date.now()) { conn.close(4009, 'dev_offline'); return; }
      let set = conns.get(s.id);
      if (!set) conns.set(s.id, (set = new Set()));
      set.add(conn);
      return attach(conn, resume);
    };
    s.detach = (conn: Conn) => { conns.get(s.id)?.delete(conn); detach(conn); };
  });

  // ---------- builds ----------

  const doLogic = async (): Promise<boolean> => {
    try {
      const prev = logic?.sha256;
      logic = await buildLogic(project);
      logicError = null;
      say(`${c.green('built')} dist/logic.js ${c.dim(logic.sha256.slice(0, 12))}`);
      for (const w of logic.warnings) say(`${c.yellow('warn')}  ${w}`);
      return prev !== logic.sha256;
    } catch (e) {
      logicError = (e as Error).message;
      say(`${c.red('logic build failed')}\n${logicError}`);
      return false;
    }
  };
  const doClient = async (): Promise<boolean> => {
    try {
      client = await buildClient(project, { dev: true });
      clientError = null;
      say(`${c.green('built')} dist/client (${client.files.length} files)`);
      return true;
    } catch (e) {
      clientError = (e as Error).message;
      say(`${c.red('client build failed')}\n${clientError}`);
      return false;
    }
  };

  // ---------- sessions ----------

  const newSession = (mode: Mode, n: number): Current => {
    if (!logic) throw new CliError(buildError() ?? 'the logic is not built');
    const id = `dev-${++counter}-${randomBytes(3).toString('hex')}`;
    const names = PLAYER_NAMES.slice(0, n);
    const cfg: SessionConfig = {
      id, appId: project.manifest.slug, versionId: 'dev', dmId: 'dev-dm', mode, flags: {},
      seed: randomBytes(16).toString('hex'),
      players: names.map((userId, seat) => ({ userId, seat, displayName: cap(userId) })),
      spectators: false, logic: { code: logic.code, sha256: logic.sha256 },
      reconnectGraceSec: project.manifest.realtime.reconnectGraceSec,
      idleTimeoutSec: 3600,
      maxDurationSec: project.manifest.realtime.maxDurationMin * 60,
      persisted: lastPersisted,
    };
    registry.add(cfg);
    current = {
      sessionId: id, mode,
      players: names.map((userId) => ({ userId, displayName: cap(userId), token: devToken({ sessionId: id, userId, appId: cfg.appId, role: 'player' }) })),
    };
    playerCount = n;
    broadcast({ type: 'session', session: current });
    say(`${c.cyan('session')} ${id} (${mode}, ${n} players)`);
    return current;
  };

  // ---------- live reload (server-sent events) ----------

  const listeners = new Set<http.ServerResponse>();
  const broadcast = (msg: object) => { for (const res of listeners) res.write(`data: ${JSON.stringify(msg)}\n\n`); };
  const ping = setInterval(() => { for (const res of listeners) res.write(': ping\n\n'); }, 15_000);
  ping.unref();

  // ---------- HTTP ----------

  const onRequest: http.RequestListener = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body)); };

    // Only this machine (protects the dev endpoints from DNS rebinding).
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return void res.writeHead(403).end('vibes-games dev only answers on localhost');

    if (path === '/' && req.method === 'GET') {
      const m = project.manifest;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(hostPage({ name: m.name, modes: m.modes, min: m.players.min, max: m.players.max }));
    }
    if (path === '/__dev/state') return json(200, { session: current, build: { ok: !buildError(), error: buildError() } });
    if (path === '/__dev/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': hello\n\n');
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;
    }
    if (path === '/__dev/new' && req.method === 'POST') {
      const mode = (url.searchParams.get('mode') ?? current?.mode ?? project.manifest.modes[0]) as Mode;
      if (!project.manifest.modes.includes(mode)) return json(400, { error: `mode ${mode} is not in vibes.json` });
      const n = clamp(Number(url.searchParams.get('players') ?? playerCount) || playerCount);
      try { return json(200, newSession(mode, n)); } catch (e) { return json(409, { error: (e as Error).message }); }
    }
    if (path === '/__dev/drop' && req.method === 'POST') {
      const ses = url.searchParams.get('ses') ?? '';
      const user = url.searchParams.get('user') ?? '';
      const sec = Math.min(300, Math.max(0, Number(url.searchParams.get('sec') ?? 0) || 0));
      if (sec > 0) offline.set(`${ses}:${user}`, Date.now() + sec * 1000);
      let closed = 0;
      for (const conn of [...(conns.get(ses) ?? [])]) if (conn.userId === user) { conn.close(4009, 'dev_drop'); closed++; }
      say(`${c.yellow('drop')}  ${user} in ${ses}: closed ${closed} socket(s)${sec ? `, offline for ${sec} s` : ''}`);
      return json(200, { closed, offlineSec: sec });
    }
    if (path === '/game') return void res.writeHead(302, { location: '/game/' }).end();
    if (path.startsWith('/game/') && (req.method === 'GET' || req.method === 'HEAD')) return serveStatic(join(project.dist, 'client'), path.slice('/game/'.length), res);
    if (path === '/favicon.ico') return void res.writeHead(204).end();
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  };

  // ---------- start ----------

  await doLogic();
  await doClient();
  if (logic) newSession(project.manifest.modes[0]!, playerCount);

  const server = createGameServer({ sessions, limits, authenticate: parseDevToken, onRequest });
  await new Promise<void>((ok, fail) => {
    server.http.once('error', (e: NodeJS.ErrnoException) => fail(e.code === 'EADDRINUSE' ? new CliError(`port ${opts.port} is in use; try --port ${opts.port + 1}`) : e));
    server.http.listen(opts.port, opts.host, () => ok());
  });
  const port = server.port();

  // ---------- watch ----------

  let timer: NodeJS.Timeout | null = null;
  let pendingLogic = false, pendingClient = false, pendingManifest = false;
  let building: Promise<void> = Promise.resolve();
  const flush = () => {
    const [l, cl, m] = [pendingLogic, pendingClient, pendingManifest];
    pendingLogic = pendingClient = pendingManifest = false;
    building = building.then(async () => {
      if (m) {
        try { project = loadProject(project.root); playerCount = clamp(playerCount); say(`${c.green('reloaded')} vibes.json`); }
        catch (e) { const msg = (e as Error).message; say(c.red(msg)); broadcast({ type: 'build', ok: false, error: msg }); return; }
      }
      const logicChanged = l || m ? await doLogic() : false;
      const clientOk = cl || m ? await doClient() : true;
      broadcast({ type: 'build', ok: !buildError(), error: buildError() });
      if (buildError()) return;
      if (logicChanged || m) {
        const mode = current && project.manifest.modes.includes(current.mode) ? current.mode : project.manifest.modes[0]!;
        newSession(mode, playerCount); // the host page reloads the iframes into the new session
      } else if (cl && clientOk) {
        broadcast({ type: 'reload' });
      }
    }).catch((e) => { say(c.red(String(e))); });
  };
  const isUnder = (p: string, d: string) => p === d || p.startsWith(d + sep);
  const onFsEvent = (_ev: string, filename: string | Buffer | null) => {
    if (!filename) return;
    const abs = resolve(project.root, filename.toString());
    const rel = relative(project.root, abs);
    if (/^(dist|node_modules|\.git)(\/|\\|$)/.test(rel) || /(^|[\\/])\.[^\\/]*$|~$/.test(rel)) return;
    if (rel === 'vibes.json') pendingManifest = true;
    if (logic?.inputs.includes(abs) || isUnder(abs, join(project.root, 'logic'))) pendingLogic = true;
    if (client?.inputs.includes(abs) || (client && isUnder(abs, client.sourceDir)) || isUnder(abs, join(project.root, 'client'))) pendingClient = true;
    if (!pendingLogic && !pendingClient && !pendingManifest) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 200);
  };
  let watcher: FSWatcher | null = null;
  try { watcher = watch(project.root, { recursive: true }, onFsEvent); }
  catch (e) { say(c.yellow(`file watching is not available here (${(e as Error).message}); restart dev after changes`)); }

  const url = `http://localhost:${port}/`;
  say('');
  say(`  ${c.bold(project.manifest.name)} is running at ${c.cyan(url)}`);
  say(`  ${c.dim(`${playerCount} players side by side; logic/ and client/ are watched. Ctrl+C to stop.`)}`);
  say('');

  return {
    port,
    async close() {
      watcher?.close();
      if (timer) clearTimeout(timer);
      clearInterval(ping);
      for (const res of listeners) res.end();
      await sessions.shutdown();
      await server.close();
    },
  };
}

function serveStatic(root: string, rel: string, res: http.ServerResponse) {
  let file: string;
  try { file = normalize(join(root, decodeURIComponent(rel || 'index.html'))); } catch { return void res.writeHead(400).end(); }
  if (!file.startsWith(root + sep) && file !== root) return void res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('not found (is the client built?)');
  res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}

function cap(s: string) { return s[0]!.toUpperCase() + s.slice(1); }

/** Runtime logs as short readable lines instead of JSON. */
function installLogger(verbose: boolean) {
  const fmt = (f?: Record<string, unknown>) => (f && Object.keys(f).length ? ' ' + c.dim(Object.entries(f).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')) : '');
  setLogger({
    debug: (m, f) => { if (verbose) process.stdout.write(`${c.dim('debug')} ${m}${fmt(f)}\n`); },
    info: (m, f) => { if (verbose || !/^(dev session started|session finished|dev session finished)$/.test(m)) process.stdout.write(`${c.dim('info')}  ${m}${fmt(f)}\n`); },
    warn: (m, f) => process.stdout.write(`${c.yellow('warn')}  ${m}${fmt(f)}\n`),
    error: (m, f) => process.stdout.write(`${c.red('error')} ${m}${fmt(f)}\n`),
  });
}
