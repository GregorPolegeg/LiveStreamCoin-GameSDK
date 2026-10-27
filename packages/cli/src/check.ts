/**
 * `vibes-games check`: the automatic release checks of spec §9.1 that can run locally.
 * Prints a PASS / WARN / FAIL report; returns false when anything failed.
 */
import { readFileSync } from 'fs';
import { extname, join, resolve } from 'path';
import { DEFAULT_LIMITS, type GameMeta } from '@vibes/game-runtime';
import { buildClient, buildLogic, forbiddenHint, loadInSandbox, type ClientBuild, type LogicBuild } from './build';
import { fuzz, type FuzzResult } from './fuzz';
import { findLogicEntry, readManifest, type Manifest, type Project } from './manifest';
import { c, kb, short } from './util';

type Level = 'PASS' | 'WARN' | 'FAIL';
interface Item { level: Level; name: string; message: string; details: string[] }

export class Report {
  items: Item[] = [];
  add(level: Level, name: string, message: string, details: string[] = []) { this.items.push({ level, name, message, details }); }
  get failed() { return this.items.some((i) => i.level === 'FAIL'); }
  print(out: (s: string) => void = (s) => process.stdout.write(s + '\n')) {
    const tag = { PASS: c.green('PASS'), WARN: c.yellow('WARN'), FAIL: c.red('FAIL') };
    for (const i of this.items) {
      out(`  ${tag[i.level]}  ${i.name.padEnd(12)} ${i.message}`);
      for (const d of i.details) out(`        ${' '.repeat(12)} ${c.dim('-')} ${d}`);
    }
    const fails = this.items.filter((i) => i.level === 'FAIL').length;
    const warns = this.items.filter((i) => i.level === 'WARN').length;
    out('');
    out(fails ? c.red(c.bold(`check FAILED: ${fails} failed, ${warns} warning(s)`)) : c.green(c.bold(`check PASSED${warns ? ` with ${warns} warning(s)` : ''}`)));
  }
}

export interface CheckOptions { games: number; steps: number; minify?: boolean }

const PURITY = /is not allowed in game logic|\b(fetch|window|document|process|require|XMLHttpRequest|WebSocket|localStorage|navigator|location|setTimeout|setInterval|setImmediate|Buffer|performance) is not defined\b/;
const ALLOWED_URLS = [/^https:\/\/(www\.)?vibes\.stream\/?$/, /^http:\/\/www\.w3\.org\//];

export async function check(dir: string, opts: CheckOptions): Promise<Report> {
  const report = new Report();
  const root = resolve(dir);

  // a. manifest
  const { manifest, problems } = readManifest(root);
  if (!manifest) { report.add('FAIL', 'manifest', 'vibes.json is not valid', problems); return report; }
  report.add('PASS', 'manifest', `${manifest.slug}: ${manifest.players.min}-${manifest.players.max} players, modes ${manifest.modes.join(', ')}`);

  // build
  let project: Project;
  let logic: LogicBuild;
  try {
    project = { root, manifest, logicEntry: findLogicEntry(root), dist: join(root, 'dist') };
    logic = await buildLogic(project, { minify: opts.minify, verifyLoad: false });
  } catch (e) {
    report.add('FAIL', 'build', 'the logic does not build', String((e as Error).message).split('\n'));
    return report;
  }
  report.add('PASS', 'build', `dist/logic.js ${kb(logic.bytes)}, sha256 ${logic.sha256}`);
  let client: ClientBuild | null = null;
  try {
    client = await buildClient(project, { minify: opts.minify });
    report.add('PASS', 'client', `dist/client: ${client.files.length} file(s)`);
  } catch (e) {
    report.add('FAIL', 'client', 'the client does not build', String((e as Error).message).split('\n'));
  }

  // b + c. loads in the sandbox (prelude removes Math.random, Date, timers, fetch …)
  const loaded = await loadInSandbox(logic.code);
  if ('error' in loaded) {
    const msg = `${loaded.error.message} (${loaded.error.kind})`;
    const hint = forbiddenHint(msg);
    report.add('FAIL', PURITY.test(msg) ? 'purity' : 'load', 'the logic crashes while loading in the sandbox', [msg, ...(hint ? [hint] : [])]);
    return report;
  }
  const meta: GameMeta = loaded.meta;
  const metaProblems: string[] = [];
  if (meta.actions.length === 0) metaProblems.push('the game has no actions (export default defineGame({ actions: { ... } }))');
  if (meta.minPlayers !== manifest.players.min) metaProblems.push(`logic minPlayers is ${meta.minPlayers}, vibes.json players.min is ${manifest.players.min}`);
  if (meta.maxPlayers !== manifest.players.max) metaProblems.push(`logic maxPlayers is ${meta.maxPlayers}, vibes.json players.max is ${manifest.players.max}`);
  if (meta.minPlayers < 1 || meta.maxPlayers < meta.minPlayers) metaProblems.push(`player counts make no sense: min ${meta.minPlayers}, max ${meta.maxPlayers}`);
  if (metaProblems.length) { report.add('FAIL', 'load', 'the game object does not match vibes.json', metaProblems); return report; }
  report.add('PASS', 'load', `loads in the sandbox; actions: ${meta.actions.join(', ')}${meta.tickHz ? `; tickHz ${meta.tickHz}` : ''}${meta.hasView ? '; has view()' : ''}`);
  if (logic.warnings.length) report.add('WARN', 'static', 'browser / Node APIs referenced in the logic bundle', logic.warnings);

  // d-f. fuzz
  const limits = { ...DEFAULT_LIMITS };
  const f = await fuzz({ code: logic.code, meta, manifest, games: opts.games, steps: opts.steps, limits });
  reportFuzz(report, f, manifest, opts, limits);

  // g. strings
  scanStrings(report, logic, client);
  return report;
}

function reportFuzz(report: Report, f: FuzzResult, manifest: Manifest, opts: CheckOptions, limits: typeof DEFAULT_LIMITS) {
  const crashLine = (x: FuzzResult['crashes'][number]) => `seed ${x.seed}, step ${x.step}, ${x.call}: ${x.kind}: ${x.message}`;

  // c. purity (banned APIs used while running)
  const purityCrashes = f.crashes.filter((x) => PURITY.test(x.message));
  const purityNotes = [...f.notes.values()].filter((n) => PURITY.test(n.message));
  if (purityCrashes.length || purityNotes.length) {
    report.add('FAIL', 'purity', 'the logic uses APIs that do not exist in the sandbox', [
      ...purityCrashes.slice(0, 3).map(crashLine),
      ...purityNotes.slice(0, 3).map((n) => `${n.message} (${n.count}x, first: seed ${n.seed}, step ${n.step}, ${n.call})`),
      'use ctx.rng for randomness and ctx.now for time; no network, DOM, timers or Node APIs',
    ]);
  } else {
    report.add('PASS', 'purity', 'no Math.random, Date, timers, fetch or Node APIs used');
  }

  // d. determinism
  if (f.divergence) {
    const d = f.divergence;
    report.add('FAIL', 'determinism', `game seed ${d.seed} gave different results with the same seed and moves (step ${d.step}, ${d.call})`, [
      `first difference at: ${d.path}`,
      `run 1: ${short(d.run1, 160)}`,
      `run 2: ${short(d.run2, 160)}`,
      'run 2 reuses one sandbox across games and restarts it mid-game (as VIBES does when a session sleeps and wakes).',
      'Usual cause: a variable outside `state` that changes (module-level counter, cache, global). Keep everything in state.',
    ]);
  } else {
    report.add('PASS', 'determinism', `${f.games} games x 2 runs with the same seed gave identical states (${f.calls} calls)`);
  }

  // e. robustness
  const other = f.crashes.filter((x) => !PURITY.test(x.message));
  if (other.length) {
    report.add('FAIL', 'robustness', `${other.length} crash(es) while fuzzing (a crash ends the session as ABANDONED)`, other.slice(0, 5).map((x) =>
      `seed ${x.seed}, step ${x.step}, ${x.call}${x.payload !== undefined ? `, payload ${short(x.payload, 80)}` : ''}: ${x.kind}: ${x.message}`));
  }
  if (f.invalidResults.length) {
    report.add('FAIL', 'robustness', 'gameOver() returned a result VIBES cannot use (the session would end as ABANDONED)', f.invalidResults.slice(0, 3).map((r) => `seed ${r.seed}: ${short(r.over, 120)}`));
  }
  if (f.noState.length) report.add('FAIL', 'robustness', 'setup() returned no state', [`seeds: ${f.noState.slice(0, 5).join(', ')}`]);
  if (!other.length && !f.invalidResults.length && !f.noState.length) {
    report.add('PASS', 'robustness', `${purityCrashes.length ? 'no other crashes' : 'no crashes'}; ${f.accepted} actions accepted, ${f.rejected} rejected; ${f.ended}/${f.games} games ended`);
  }
  const sloppy = [...f.notes.values()].filter((n) => !PURITY.test(n.message));
  if (sloppy.length) {
    report.add('WARN', 'robustness', 'actions threw errors that are not reject codes (players only see "rejected"); check payloads and throw new Error(\'some_code\')',
      sloppy.slice(0, 4).map((n) => `${n.message} (${n.count}x, e.g. seed ${n.seed}, step ${n.step}, ${n.call})`));
  }
  if (f.unfinished) report.add('WARN', 'robustness', `${f.unfinished}/${f.games} fuzz games did not end within ${opts.steps} steps (fine if your game needs real play to finish)`);
  if (f.accepted === 0 && f.games > 0) report.add('WARN', 'robustness', 'the fuzz bots never got an action accepted, so the checks above saw little of the game');

  // f. performance
  const cpu = [...f.cpuMs].sort((a, b) => a - b);
  const p = (q: number) => (cpu.length ? cpu[Math.min(cpu.length - 1, Math.floor(q * cpu.length))]! : 0);
  const p99 = p(0.99);
  const perf = `CPU per call p50 ${p(0.5).toFixed(2)} ms, p99 ${p99.toFixed(2)} ms, max ${(cpu[cpu.length - 1] ?? 0).toFixed(2)} ms (limits: soft ${limits.softCpuMs} ms, hard ${limits.hardCpuMs} ms)`;
  if (p99 > limits.hardCpuMs) report.add('FAIL', 'performance', perf);
  else if (p99 >= limits.softCpuMs * 0.8) report.add('WARN', 'performance', perf, [`keep p99 under ${limits.softCpuMs * 0.8} ms; each call over ${limits.softCpuMs} ms is a strike, ${limits.maxStrikes} strikes end the session`]);
  else report.add('PASS', 'performance', perf);
  const st = `largest state ${kb(f.maxStateBytes)} (seed ${f.maxStateSeed || '-'}), limit ${kb(limits.maxStateBytes)}`;
  if (f.maxStateBytes > limits.maxStateBytes) report.add('FAIL', 'performance', st, ['actions that grow the state over the limit are refused (state_too_large)']);
  else if (f.maxStateBytes > limits.maxStateBytes * 0.8) report.add('WARN', 'performance', st);
  else report.add('PASS', 'performance', st);

  // manifest turn clock vs logic turn clock
  const t = manifest.realtime.turnTimeoutSec;
  if (t !== undefined && f.turnSeconds.size && !f.turnSeconds.has(t)) {
    report.add('WARN', 'manifest', `realtime.turnTimeoutSec is ${t} but the logic's turnTimer.seconds is ${[...f.turnSeconds].join(', ')}`);
  }
}

function scanStrings(report: Report, logic: LogicBuild, client: ClientBuild | null) {
  const vbot: string[] = [];
  if (logic.code.includes('vbot_')) vbot.push('dist/logic.js');
  const urls = new Map<string, Set<string>>();
  const evals: string[] = [];
  for (const rel of client?.files ?? []) {
    if (!['.js', '.mjs', '.html', '.css', '.json', '.svg', '.txt', '.map'].includes(extname(rel))) continue;
    const text = readFileSync(join(client!.dir, rel), 'utf8');
    if (text.includes('vbot_')) vbot.push(`dist/client/${rel}`);
    if (rel.endsWith('.map')) continue;
    for (const m of text.matchAll(/\bhttps?:\/\/[^\s"'`)<>\\]+/g)) {
      const url = m[0].replace(/[.,;]+$/, '');
      if (ALLOWED_URLS.some((a) => a.test(url))) continue;
      const set = urls.get(url) ?? new Set<string>();
      set.add(`dist/client/${rel}`);
      urls.set(url, set);
    }
    if (/\.js$|\.mjs$/.test(rel) && /(?<![\w$.])(eval\s*\(|new\s+Function\s*\()/.test(text)) evals.push(`dist/client/${rel}`);
  }
  if (vbot.length) report.add('FAIL', 'bundle', 'contains "vbot_" (looks like a VIBES bot token; never ship tokens)', vbot);
  else report.add('PASS', 'bundle', 'no "vbot_" strings');
  if (urls.size) {
    report.add('WARN', 'client', 'external URLs in client files (VIBES serves games without outside scripts, fonts or fetch targets)',
      [...urls].slice(0, 10).map(([u, files]) => `${u}  (${[...files].join(', ')})`));
  }
  if (evals.length) report.add('WARN', 'client', 'eval / new Function in the client (not allowed on VIBES)', evals);
}
