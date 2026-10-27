/**
 * vibes.json, the game's manifest (spec §3). Only what the CLI needs today:
 *
 *   {
 *     "name": "Tic Tac Toe",
 *     "slug": "tic-tac-toe",
 *     "players": { "min": 2, "max": 2 },
 *     "modes": ["friendly", "competitive", "practice"],
 *     "client": { "entry": "client/main.ts" },        // or { "dir": "client/dist" } (already built, e.g. Vite)
 *     "realtime": { "reconnectGraceSec": 45, "turnTimeoutSec": 30, "maxDurationMin": 60 }
 *   }
 *
 * The logic entry is always logic/index.ts (or .js).
 */
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { CliError } from './util';

export type Mode = 'friendly' | 'competitive' | 'practice';
export const MODES: readonly Mode[] = ['friendly', 'competitive', 'practice'];
export const SLUG = /^[a-z0-9-]{3,40}$/;
export const MAX_PLAYERS = 16;

export interface Manifest {
  name: string;
  slug: string;
  players: { min: number; max: number };
  modes: Mode[];
  /** `entry`: the CLI bundles it with esbuild. `dir`: an already-built folder with index.html. */
  client: { entry?: string; dir?: string };
  realtime: { reconnectGraceSec: number; turnTimeoutSec?: number; maxDurationMin: number };
}

export interface Project {
  root: string;
  manifest: Manifest;
  logicEntry: string;
  dist: string;
}

/** Problems with the manifest, in plain English. Empty = valid. */
export function validateManifest(raw: unknown): { manifest: Manifest | null; problems: string[] } {
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { manifest: null, problems: ['vibes.json must be a JSON object'] };
  const m = raw as Record<string, any>;
  const int = (v: unknown) => Number.isInteger(v);

  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 60) problems.push('"name" must be a non-empty string (max 60 characters)');
  if (typeof m.slug !== 'string' || !SLUG.test(m.slug)) problems.push('"slug" must be 3-40 characters of a-z, 0-9 and "-"');

  const p = m.players;
  if (!p || typeof p !== 'object' || !int(p.min) || !int(p.max)) problems.push('"players" must be { "min": <int>, "max": <int> }');
  else {
    if (p.min < 1) problems.push('"players.min" must be at least 1');
    if (p.min > p.max) problems.push('"players.min" must be <= "players.max"');
    if (p.max > MAX_PLAYERS) problems.push(`"players.max" must be <= ${MAX_PLAYERS}`);
  }

  const modes = m.modes === undefined ? [...MODES] : m.modes;
  if (!Array.isArray(modes) || modes.length === 0) problems.push('"modes" must be a non-empty list');
  else for (const x of modes) if (!MODES.includes(x)) problems.push(`unknown mode "${x}" (allowed: ${MODES.join(', ')})`);
  if (Array.isArray(modes) && new Set(modes).size !== modes.length) problems.push('"modes" has duplicates');

  const client = m.client === undefined ? {} : m.client;
  if (!client || typeof client !== 'object') problems.push('"client" must be an object');
  else {
    if (client.entry !== undefined && typeof client.entry !== 'string') problems.push('"client.entry" must be a path');
    if (client.dir !== undefined && typeof client.dir !== 'string') problems.push('"client.dir" must be a path');
    if (client.entry !== undefined && client.dir !== undefined) problems.push('use either "client.entry" or "client.dir", not both');
  }

  const rt = m.realtime === undefined ? {} : m.realtime;
  const realtime = { reconnectGraceSec: 45, maxDurationMin: 60, ...(rt && typeof rt === 'object' ? rt : {}) };
  if (!rt || typeof rt !== 'object') problems.push('"realtime" must be an object');
  else {
    if (!int(realtime.reconnectGraceSec) || realtime.reconnectGraceSec < 0 || realtime.reconnectGraceSec > 600) problems.push('"realtime.reconnectGraceSec" must be 0-600');
    if (realtime.turnTimeoutSec !== undefined && (!int(realtime.turnTimeoutSec) || realtime.turnTimeoutSec < 1 || realtime.turnTimeoutSec > 86_400)) problems.push('"realtime.turnTimeoutSec" must be 1-86400');
    if (!int(realtime.maxDurationMin) || realtime.maxDurationMin < 1 || realtime.maxDurationMin > 7 * 24 * 60) problems.push('"realtime.maxDurationMin" must be 1-10080');
  }

  if (problems.length) return { manifest: null, problems };
  return {
    manifest: {
      name: m.name.trim(), slug: m.slug, players: { min: p.min, max: p.max }, modes: [...modes],
      client: client.dir !== undefined ? { dir: client.dir } : { entry: client.entry ?? 'client/main.ts' },
      realtime,
    },
    problems,
  };
}

export function readManifest(root: string): { manifest: Manifest | null; problems: string[] } {
  const file = join(root, 'vibes.json');
  if (!existsSync(file)) return { manifest: null, problems: [`no vibes.json in ${root} (run this inside a game project, or pass --dir)`] };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    return { manifest: null, problems: [`vibes.json is not valid JSON: ${(e as Error).message}`] };
  }
  return validateManifest(raw);
}

/** Loads the project or throws a CliError listing what is wrong. */
export function loadProject(dir: string): Project {
  const root = resolve(dir);
  const { manifest, problems } = readManifest(root);
  if (!manifest) throw new CliError(`vibes.json is not valid:\n  - ${problems.join('\n  - ')}`);
  return { root, manifest, logicEntry: findLogicEntry(root), dist: join(root, 'dist') };
}

export function findLogicEntry(root: string): string {
  for (const f of ['logic/index.ts', 'logic/index.js', 'logic/index.mts', 'logic/index.mjs']) {
    if (existsSync(join(root, f))) return join(root, f);
  }
  throw new CliError(`no logic entry: create logic/index.ts with \`export default defineGame({ ... })\``);
}
