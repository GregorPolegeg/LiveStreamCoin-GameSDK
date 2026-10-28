// login / push / submit against a stand-in for the VIBES API (same routes and shapes as LiveStreamCoin-Backend).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { join } from 'path';

const repo = join(__dirname, '..', '..', '..');
const work = join(repo, '.scratch', `publish-test-${randomBytes(3).toString('hex')}`);
const home = join(work, 'home');
const cli = join(__dirname, '..', 'dist', 'index.js');
mkdirSync(home, { recursive: true });
after(() => rmSync(work, { recursive: true, force: true }));

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `${b64({ alg: 'HS256' })}.${b64({ type: 'game-dev', app: 'app-1', sub: 'u-1' })}.sig`;

function run(args: string[], cwd: string, port: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, HOME: home, VIBES_API: `http://127.0.0.1:${port}`, NO_COLOR: '1' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code: code ?? 1, out }));
  });
}

test('login, push (checks + upload), submit', { timeout: 240_000 }, async () => {
  const uploads: { paths: string[]; check: any }[] = [];
  const submitted: string[] = [];
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: object) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'bad token' });
    if (req.method === 'GET' && req.url === '/api/games/dev/apps/app-1') return send(200, { app: { id: 'app-1', name: 'Quiz Night', slug: 'quiz-night' }, versions: [] });
    if (req.method === 'POST' && req.url === '/api/games/dev/apps/app-1/versions') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      // parse the multipart body the way the backend (multer, preservePath) sees it
      const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type']! }, body: Buffer.concat(chunks) }).formData();
      const files = form.getAll('files') as File[];
      const checkFile = files.find((f) => f.name === 'check.json');
      uploads.push({ paths: files.map((f) => f.name), check: checkFile ? JSON.parse(await checkFile.text()) : null });
      return send(201, { id: 'v-1', version: '0.1.0', review: 'testing', clientUrl: 'https://games.vibes.stream/sdk/quiz-night/0.1.0/', next: 'Open a chat → + → Games' });
    }
    const m = /^\/api\/games\/dev\/apps\/app-1\/versions\/([^/]+)\/submit$/.exec(req.url ?? '');
    if (req.method === 'POST' && m) { submitted.push(decodeURIComponent(m[1]!)); return send(200, { id: 'v-1', version: m[1], review: 'pending' }); }
    send(404, { error: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const dir = join(work, 'game');
    cpSync(join(repo, 'packages', 'create', 'template'), dir, { recursive: true });

    assert.equal((await run(['push'], dir, port)).code, 1, 'push before login fails with a hint');
    const login = await run(['login', '--token', TOKEN], dir, port);
    assert.equal(login.code, 0, login.out);
    assert.match(login.out, /logged in Quiz Night/);
    const creds = JSON.parse(readFileSync(join(home, '.vibes', 'games.json'), 'utf8'));
    assert.equal(creds.apps['app-1'].token, TOKEN);

    const push = await run(['push', '--submit'], dir, port);
    assert.equal(push.code, 0, push.out);
    assert.match(push.out, /uploaded 0\.1\.0: testing/);
    const up = uploads[0]!;
    assert.ok(up.paths.includes('vibes.json') && up.paths.includes('logic.js') && up.paths.includes('client/index.html') && up.paths.includes('client/main.js'), up.paths.join(','));
    assert.ok(!up.paths.some((p) => p.endsWith('.map')));
    assert.equal(up.check.failed, false, 'the check report goes along');
    assert.ok(up.check.items.some((i: { name: string }) => i.name === 'determinism'));
    assert.deepEqual(submitted, ['0.1.0']);

    // a game whose checks fail is not uploaded
    writeFileSync(join(dir, 'logic', 'index.ts'), readFileSync(join(dir, 'logic', 'index.ts'), 'utf8').replace('setup({ players, rng }): State {', 'setup({ players, rng }): State {\n    if (Math.random() > 2) throw new Error("x");'));
    const bad = await run(['push'], dir, port);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /not uploaded/);
    assert.equal(uploads.length, 1);
  } finally {
    server.close();
  }
});
