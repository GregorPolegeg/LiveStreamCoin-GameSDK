import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

// Projects live inside the monorepo (.scratch is gitignored) so @vibes/* resolve from its node_modules.
const repo = join(__dirname, '..', '..', '..');
const work = join(repo, '.scratch', `cli-test-${randomBytes(3).toString('hex')}`);
const cli = join(__dirname, '..', 'dist', 'index.js');
const template = join(repo, 'packages', 'create', 'template');
mkdirSync(work, { recursive: true });
after(() => rmSync(work, { recursive: true, force: true }));

function project(name: string, edit?: (dir: string) => void): string {
  const dir = join(work, name);
  cpSync(template, dir, { recursive: true });
  if (edit) edit(dir);
  return dir;
}

function patch(file: string, from: string, to: string) {
  const s = readFileSync(file, 'utf8');
  assert.ok(s.includes(from), `patch target not found in ${file}: ${from}`);
  writeFileSync(file, s.replace(from, to));
}

function run(dir: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('build: dist/logic.js sets globalThis.__vibesGame, sha256 printed, client built', () => {
  const dir = project('ok-build');
  const r = run(dir, 'build');
  assert.equal(r.code, 0, r.out);
  const code = readFileSync(join(dir, 'dist', 'logic.js'), 'utf8');
  assert.match(code, /globalThis\.__vibesGame = __vibesGameModule\.default \|\| __vibesGameModule;/);
  assert.ok(r.out.includes(createHash('sha256').update(code).digest('hex')), r.out);
  for (const f of ['index.html', 'main.js', 'style.css']) assert.ok(existsSync(join(dir, 'dist', 'client', f)), f);
  assert.ok(!existsSync(join(dir, 'dist', 'client', 'main.ts')));
});

test('check: the template passes', () => {
  const r = run(project('ok-check'), 'check', '--games', '40');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS\s+determinism/);
  assert.match(r.out, /check PASSED/);
});

test('check: Math.random fails purity', () => {
  const dir = project('bad-random', (d) => patch(join(d, 'logic', 'index.ts'),
    'place(state, rng.pick(free), playerId)', 'place(state, free[Math.floor(Math.random() * free.length)]!, playerId)'));
  const r = run(dir, 'check', '--games', '40');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL\s+purity/);
  assert.match(r.out, /Math\.random is not allowed in game logic/);
});

test('check: Math.random swallowed as a rejection inside an action still fails purity', () => {
  const dir = project('bad-random-action', (d) => patch(join(d, 'logic', 'index.ts'),
    '      place(state, cell, playerId);\n    },', "      place(state, cell, playerId);\n      if (Math.random() < 0) state.turn = '';\n    },"));
  const r = run(dir, 'check', '--games', '20');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL\s+purity/);
});

test('check: a module-level counter (state outside `state`) fails determinism', () => {
  const dir = project('bad-counter', (d) => {
    const f = join(d, 'logic', 'index.ts');
    patch(f, "export type { State } from './rules';", "export type { State } from './rules';\nlet moves = 0;");
    patch(f, '      place(state, cell, playerId);\n    },', '      place(state, cell, playerId);\n      (state as State & { n?: number }).n = ++moves;\n    },');
  });
  const r = run(dir, 'check', '--games', '40');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL\s+determinism\s+game seed fuzz-\d+ gave different results/);
  assert.match(r.out, /first difference at: state\.n/);
});

test('check: Date.now at the top level fails with the real message', () => {
  const dir = project('bad-toplevel', (d) => patch(join(d, 'logic', 'index.ts'), "export type { State } from './rules';", "export type { State } from './rules';\nexport const t0 = Date.now();"));
  const r = run(dir, 'check', '--games', '5');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL\s+purity.*\n.*Date\.now is not allowed/);
});

test('check: a crash in gameOver fails robustness with the action and seed', () => {
  const dir = project('bad-crash', (d) => patch(join(d, 'logic', 'index.ts'),
    '    const w = winner(state.board);', "    if (state.board[8]) throw new TypeError('boom');\n    const w = winner(state.board);"));
  const r = run(dir, 'check', '--games', '40');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL\s+robustness/);
  assert.match(r.out, /seed fuzz-\d+, step \d+, .*crash: TypeError: boom|crash: boom/);
});

test('build: importing a Node built-in fails with a clear error', () => {
  const dir = project('bad-node', (d) => patch(join(d, 'logic', 'rules.ts'), '// The rules', "import { readFileSync } from 'fs';\nexport const words = () => readFileSync('w.txt', 'utf8');\n// The rules"));
  const r = run(dir, 'build');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /"fs" is a Node\.js built-in module/);
});

test('check: an invalid manifest fails', () => {
  const dir = project('bad-manifest', (d) => {
    const m = JSON.parse(readFileSync(join(d, 'vibes.json'), 'utf8'));
    m.slug = 'X'; m.players = { min: 3, max: 2 }; m.modes = ['ranked'];
    writeFileSync(join(d, 'vibes.json'), JSON.stringify(m));
  });
  const r = run(dir, 'check');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL\s+manifest/);
  assert.match(r.out, /slug/);
  assert.match(r.out, /unknown mode "ranked"/);
});

test('publishing without a token says where to get one', () => {
  const login = run(work, 'login');
  assert.equal(login.code, 1);
  assert.match(login.out, /login --token/);
  const bad = run(work, 'login', '--token', 'not-a-token');
  assert.equal(bad.code, 1);
  assert.match(bad.out, /upload token/);
});
