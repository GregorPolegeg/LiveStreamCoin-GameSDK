import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_LIMITS, Sandbox, SandboxError, sha256, normalizeResult } from '../src';

const limits = { ...DEFAULT_LIMITS };
const tictactoe = readFileSync(join(__dirname, '..', '..', '..', 'examples', 'tictactoe', 'logic.js'), 'utf8');
const base = { persisted: { players: {}, dm: {} }, now: 1, mode: 'friendly', flags: {}, viewers: ['a', 'b'] };
const players = [{ userId: 'a', seat: 0 }, { userId: 'b', seat: 1 }];

const game = (setupBody: string, extra = '') =>
  `globalThis.__vibesGame = { minPlayers: 1, maxPlayers: 2, setup(ctx) { ${setupBody} }, actions: {}, ${extra} };`;

async function expectKind(code: string, kind: SandboxError['kind']) {
  const sb = await Sandbox.create(code, sha256(code), limits).catch((e) => e);
  if (sb instanceof SandboxError) return assert.equal(sb.kind, kind);
  try {
    await assert.rejects(sb.run('setup', { ...base, rng: 1, players }), (e: SandboxError) => e.kind === kind);
  } finally { sb.dispose(); }
}

test('same seed → same game (determinism)', async () => {
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const sb = await Sandbox.create(tictactoe, sha256(tictactoe), limits);
    let out = await sb.run('setup', { ...base, rng: 777, players });
    const first = (out.state as any).turn;
    out = await sb.run('timeout', { ...base, state: out.state, rng: out.rng, playerId: first });
    runs.push(JSON.stringify(out));
    sb.dispose();
  }
  assert.equal(runs[0], runs[1]);
});

test('actions: rejections come back as codes, state is untouched', async () => {
  const sb = await Sandbox.create(tictactoe, sha256(tictactoe), limits);
  const s = await sb.run('setup', { ...base, rng: 1, players });
  const turn = (s.state as any).turn as string;
  const other = turn === 'a' ? 'b' : 'a';
  assert.deepEqual(await sb.run('action', { ...base, state: s.state, rng: s.rng, name: 'place', payload: 0, playerId: other }), { rejected: 'not_your_turn' });
  assert.deepEqual(await sb.run('action', { ...base, state: s.state, rng: s.rng, name: 'place', payload: 99, playerId: turn }), { rejected: 'bad_cell' });
  assert.deepEqual(await sb.run('action', { ...base, state: s.state, rng: s.rng, name: 'constructor', payload: 0, playerId: turn }), { rejected: 'unknown_action' });
  assert.deepEqual(await sb.run('action', { ...base, state: s.state, rng: s.rng, name: '__proto__', payload: 0, playerId: turn }), { rejected: 'unknown_action' });
  sb.dispose();
});

test('no outside world: random, time, network, node, process', async () => {
  await expectKind(game('Math.random(); return {}'), 'crash');
  await expectKind(game('Date.now(); return {}'), 'crash');
  await expectKind(game('new Date(); return {}'), 'crash');
  await expectKind(game('fetch("https://example.com"); return {}'), 'crash');
  await expectKind(game('require("fs"); return {}'), 'crash');
  await expectKind(game('process.exit(1); return {}'), 'crash');
  await expectKind(game('(function(){}).constructor("return process")().exit(); return {}'), 'crash');
  await expectKind(game('setTimeout(() => {}, 1); return {}'), 'crash');
});

test('limits: endless loops time out, memory bombs are killed', async () => {
  await expectKind(game('while (true) {}'), 'timeout');
  await expectKind(game('const a = []; while (true) a.push(new Array(1e6).fill(1)); return {}'), 'memory');
  await expectKind('while (true) {}', 'timeout'); // at load time too
});

test('a bundle that does not match its hash never runs', async () => {
  await assert.rejects(Sandbox.create(tictactoe, 'f'.repeat(64), limits), (e: SandboxError) => e.kind === 'invalid');
});

test('view(): each player only sees their own view, and view() cannot change the state', async () => {
  const code = `globalThis.__vibesGame = { minPlayers: 2, maxPlayers: 2,
    setup: () => ({ hands: { a: [1], b: [2] } }), actions: {},
    view(state, id) { const h = state.hands; state.hands = null; return id ? { mine: h[id] } : { spectator: true }; } };`;
  const sb = await Sandbox.create(code, sha256(code), limits);
  const out = await sb.run('setup', { ...base, rng: 1, players, viewers: ['a', 'b', null] });
  assert.deepEqual(out.views, { a: { mine: [1] }, b: { mine: [2] }, '': { spectator: true } });
  assert.deepEqual(out.state, { hands: { a: [1], b: [2] } });
  sb.dispose();
});

test('normalizeResult only accepts real players and sane places', () => {
  const ps = [{ userId: 'a', seat: 0 }, { userId: 'b', seat: 1 }, { userId: 'c', seat: 2 }];
  assert.deepEqual(normalizeResult({ placements: [{ userId: 'a', place: 1 }], rest: 2 }, ps)?.placements,
    [{ userId: 'a', place: 1 }, { userId: 'b', place: 2 }, { userId: 'c', place: 2 }]);
  assert.equal(normalizeResult({ draw: true }, ps)?.draw, true);
  assert.equal(normalizeResult({ placements: [{ userId: 'zed', place: 1 }] }, ps), null);
  assert.equal(normalizeResult({ placements: [{ userId: 'a', place: 1 }, { userId: 'a', place: 2 }] }, ps), null);
  assert.equal(normalizeResult({ placements: [{ userId: 'a', place: 0 }] }, ps), null);
  assert.equal(normalizeResult({ placements: [{ userId: 'a', place: 1, score: Infinity }] }, ps), null);
  assert.equal(normalizeResult('win', ps), null);
});
