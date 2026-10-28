/**
 * Publishing, one command (like itch.io's `butler push`):
 *
 *   vibes-games login --token <token>   once: the upload token from the portal (Applications → your app → Game)
 *   vibes-games push [--submit]         build, run the checks, upload → "Testing": only you see it under + → Games
 *   vibes-games submit [version]        send a tested version to review
 *
 * Credentials: ~/.vibes/games.json (mode 600). VIBES_GAMES_TOKEN and VIBES_API override it (CI).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, relative, resolve, sep } from 'path';
import { buildClient, buildLogic } from './build';
import { check } from './check';
import { loadProject } from './manifest';
import { c, CliError, kb } from './util';

export const DEFAULT_API = 'https://backend.vibes.stream';
const CRED_DIR = join(homedir(), '.vibes');
const CRED_FILE = join(CRED_DIR, 'games.json');

interface Creds { api: string; apps: Record<string, { token: string; name?: string; slug?: string }>; projects: Record<string, string> }

function readCreds(): Creds {
  try { return { api: DEFAULT_API, apps: {}, projects: {}, ...JSON.parse(readFileSync(CRED_FILE, 'utf8')) }; } catch { return { api: DEFAULT_API, apps: {}, projects: {} }; }
}
function writeCreds(cr: Creds) {
  mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CRED_FILE, JSON.stringify(cr, null, 2), { mode: 0o600 });
  try { chmodSync(CRED_FILE, 0o600); } catch { /* windows */ }
}

/** The app id inside an upload token (a JWT; we only read it, the server checks it). */
export function appOfToken(token: string): string {
  const part = token.split('.')[1];
  if (!part) throw new CliError('that is not an upload token (make one in the portal: Applications → your app → Game)');
  try {
    const p = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (p.type !== 'game-dev' || typeof p.app !== 'string') throw new Error('x');
    return p.app;
  } catch { throw new CliError('that is not a VIBES game upload token'); }
}

async function api(base: string, token: string, method: string, path: string, body?: FormData | object): Promise<any> {
  const res = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  }).catch((e: Error) => { throw new CliError(`can't reach ${base}: ${e.message}`); });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) {
    const problems: string[] = Array.isArray(data?.problems) ? data.problems : [];
    throw new CliError(`${data?.error ?? `${res.status} ${res.statusText}`}${problems.length > 1 ? `\n  - ${problems.join('\n  - ')}` : ''}`);
  }
  return data;
}

/** Which app (and token) this project publishes to. */
function target(dir: string, appFlag?: string): { base: string; appId: string; token: string } {
  const cr = readCreds();
  const base = process.env.VIBES_API || cr.api || DEFAULT_API;
  if (process.env.VIBES_GAMES_TOKEN) return { base, appId: appOfToken(process.env.VIBES_GAMES_TOKEN), token: process.env.VIBES_GAMES_TOKEN };
  const root = resolve(dir);
  const ids = Object.keys(cr.apps);
  const appId = appFlag ?? cr.projects[root] ?? (ids.length === 1 ? ids[0] : undefined);
  if (!appId) {
    if (!ids.length) throw new CliError('not logged in: run `vibes-games login --token <token>` (the token is in the portal: Applications → your app → Game)');
    throw new CliError(`you are logged in to ${ids.length} apps; pick one with --app <id>:\n  ${ids.map((i) => `${i}  ${cr.apps[i]!.name ?? ''}`).join('\n  ')}`);
  }
  const entry = cr.apps[appId];
  if (!entry) throw new CliError(`no token for app ${appId}: run \`vibes-games login --token <token>\``);
  return { base, appId, token: entry.token };
}

export async function login(token: string | undefined, apiBase: string | undefined, dir: string): Promise<number> {
  if (!token) throw new CliError('usage: vibes-games login --token <token>   (portal: Applications → your app → Game → Make token)');
  const appId = appOfToken(token);
  const cr = readCreds();
  const base = apiBase ?? process.env.VIBES_API ?? cr.api ?? DEFAULT_API;
  const info = await api(base, token, 'GET', `/api/games/dev/apps/${appId}`);
  cr.api = base;
  cr.apps[appId] = { token, name: info.app?.name, slug: info.app?.slug };
  // this folder publishes to this app from now on
  if (existsSync(join(resolve(dir), 'vibes.json'))) cr.projects[resolve(dir)] = appId;
  writeCreds(cr);
  process.stdout.write(`${c.green('logged in')} ${info.app?.name ?? appId} (${info.versions?.length ?? 0} version(s) so far)\n` +
    `next: ${c.cyan('vibes-games push')} in your game folder\n`);
  return 0;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  (function go(d: string) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) go(p); else out.push(p); } })(dir);
  return out;
}

export async function push(dir: string, opts: { submit?: boolean; skipCheck?: boolean; app?: string; games?: number }): Promise<number> {
  const project = loadProject(dir);
  const t = target(project.root, opts.app);
  const pkgFile = join(project.root, 'package.json');
  const version = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, 'utf8')).version : undefined;
  process.stdout.write(`${c.cyan('push')} ${project.manifest.name} ${version ?? '(no version)'} → ${t.base}\n`);

  // 1. the same checks VIBES reviews against (they also build dist/, minified)
  let report: { items: unknown[]; failed: boolean } | null = null;
  if (!opts.skipCheck) {
    const r = await check(project.root, { games: opts.games ?? 120, steps: 300, minify: true });
    r.print();
    if (r.failed) { process.stderr.write(`${c.red('not uploaded')}: fix the failed checks first (or --skip-check, and the reviewer sees it was skipped)\n`); return 1; }
    report = { items: r.items, failed: r.failed };
  } else {
    await buildLogic(project, { minify: true });
    await buildClient(project, { minify: true });
  }

  // 2. the files: vibes.json, package.json, logic.js, client/**, check.json
  const form = new FormData();
  let bytes = 0;
  const add = (path: string, data: Buffer, type = 'application/octet-stream') => { bytes += data.length; form.append('files', new Blob([new Uint8Array(data)], { type }), path); };
  add('vibes.json', readFileSync(join(project.root, 'vibes.json')), 'application/json');
  if (existsSync(pkgFile)) add('package.json', readFileSync(pkgFile), 'application/json');
  add('logic.js', readFileSync(join(project.dist, 'logic.js')), 'text/javascript');
  const clientDir = join(project.dist, 'client');
  const clientFiles = walk(clientDir).filter((f) => !f.endsWith('.map'));
  for (const f of clientFiles) add(`client/${relative(clientDir, f).split(sep).join('/')}`, readFileSync(f));
  add('check.json', Buffer.from(JSON.stringify({ tool: 'vibes-games check', at: new Date().toISOString(), ...(report ?? { skipped: true }) })), 'application/json');
  process.stdout.write(`${c.cyan('upload')} ${clientFiles.length + 4} files, ${kb(bytes)}…\n`);

  // 3. upload → Testing
  const res = await api(t.base, t.token, 'POST', `/api/games/dev/apps/${t.appId}/versions`, form);
  process.stdout.write(`${c.green('uploaded')} ${res.version}: ${res.review}\n  ${res.next ?? ''}\n  client: ${res.clientUrl}\n`);
  if (opts.submit) {
    const s = await api(t.base, t.token, 'POST', `/api/games/dev/apps/${t.appId}/versions/${encodeURIComponent(res.version)}/submit`);
    process.stdout.write(`${c.green('submitted')} ${s.version} for review\n`);
  } else {
    process.stdout.write(`when it plays well: ${c.cyan(`vibes-games submit ${res.version}`)}\n`);
  }
  // remember: this folder publishes to this app
  const cr = readCreds();
  if (!process.env.VIBES_GAMES_TOKEN && cr.projects[project.root] !== t.appId) { cr.projects[project.root] = t.appId; writeCreds(cr); }
  return 0;
}

export async function submit(dir: string, version: string | undefined, app?: string): Promise<number> {
  const t = target(dir, app);
  let v = version;
  if (!v) {
    const info = await api(t.base, t.token, 'GET', `/api/games/dev/apps/${t.appId}`);
    v = info.versions?.find((x: { review: string }) => x.review === 'testing')?.version;
    if (!v) throw new CliError('no version in Testing to submit (push one first)');
  }
  const s = await api(t.base, t.token, 'POST', `/api/games/dev/apps/${t.appId}/versions/${encodeURIComponent(v)}/submit`);
  process.stdout.write(`${c.green('submitted')} ${s.version} for review: you'll see the result in the portal (Applications → Game)\n`);
  return 0;
}

export async function status(dir: string, app?: string): Promise<number> {
  const t = target(dir, app);
  const info = await api(t.base, t.token, 'GET', `/api/games/dev/apps/${t.appId}`);
  process.stdout.write(`${info.app.name} (${info.app.listing === 'listed' ? 'listed' : 'testing'})\n`);
  for (const v of info.versions) process.stdout.write(`  ${v.version.padEnd(10)} ${v.review.padEnd(9)} ${v.live ? c.green('LIVE') : ''}${v.reviewNote ? `  note: ${v.reviewNote}` : ''}\n`);
  return 0;
}
