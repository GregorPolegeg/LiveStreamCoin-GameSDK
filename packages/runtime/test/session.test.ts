import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, session, sleep, startServer, tictactoe, token } from './helpers';

async function twoPlayers(srv: Awaited<ReturnType<typeof startServer>>, cfg = session(tictactoe)) {
  srv.registry.add(cfg);
  const a = await Client.connect(srv.port, cfg.id, token(cfg.id, 'alice'));
  const wa = await a.wait((f) => f.t === 'welcome');
  const b = await Client.connect(srv.port, cfg.id, token(cfg.id, 'bob'));
  await b.wait((f) => f.t === 'welcome');
  const first = wa.s.turn as string;
  const [p1, p2] = first === 'alice' ? [a, b] : [b, a];
  return { cfg, a, b, p1, p2, first };
}

test('full game: one order for everyone, rejections, result reported once', async () => {
  const srv = await startServer();
  try {
    const { cfg, a, b, p1, p2, first } = await twoPlayers(srv);
    assert.equal((await p2.reply(p2.act('place', 0))).err, 'not_your_turn');
    // p1 wins with 0,1,2 while p2 plays 3,4
    for (const [c, cell] of [[p1, 0], [p2, 3], [p1, 1], [p2, 4], [p1, 2]] as const) {
      const r = await c.reply(c.act('place', cell));
      assert.equal(r.t, 'ok', JSON.stringify(r));
    }
    const endA = await a.wait((f) => f.t === 'end');
    const endB = await b.wait((f) => f.t === 'end');
    assert.equal(endA.status, 'COMPLETED');
    assert.deepEqual(endA.result, endB.result);
    assert.equal(endA.result.placements.find((p: any) => p.place === 1).userId, first);
    const seqsA = a.frames.filter((f) => f.t === 'u').map((f) => f.seq);
    const seqsB = b.frames.filter((f) => f.t === 'u').map((f) => f.seq);
    assert.deepEqual(seqsA, [1, 2, 3, 4, 5]);
    assert.deepEqual(seqsA, seqsB);
    await sleep(50);
    const outcome = srv.registry.outcomes.get(cfg.id)!;
    assert.equal(outcome.status, 'COMPLETED');
    assert.equal(outcome.log.length, 5);
    // late action after the end
    assert.equal((await p2.reply(p2.act('place', 8))).err, 'session_over');
  } finally { await srv.close(); }
});

test('auth: bad tokens, other sessions, outsiders and non-auth first frames are refused', async () => {
  const srv = await startServer();
  try {
    const cfg = session(tictactoe);
    srv.registry.add(cfg);
    const cases: [string, number][] = [
      ['garbage', 4003],
      [token('another-session', 'alice'), 4003],
      [token(cfg.id, 'mallory'), 4003],
      [token(cfg.id, 'alice', { role: 'spectator' }), 4003],
      [token(cfg.id, 'alice', { app: 'other-app' }), 4004],
    ];
    for (const [tok, code] of cases) {
      const c = await Client.connect(srv.port, cfg.id, tok);
      assert.equal((await c.closedWith()).code, code);
    }
    const d = new Client(srv.port, cfg.id);
    await d.open;
    d.send({ t: 'act', id: 'a1', name: 'place', p: 0 });
    assert.equal((await d.closedWith()).code, 4001);
  } finally { await srv.close(); }
});

test('exactly once: a resent action id gets the same seq and is not applied twice', async () => {
  const srv = await startServer();
  try {
    const { p1 } = await twoPlayers(srv);
    const r1 = await p1.reply(p1.act('place', 4, 'same-id'));
    p1.frames = [];
    const r2 = await p1.reply(p1.act('place', 4, 'same-id'));
    assert.equal(r1.seq, r2.seq);
    assert.equal(r2.dup, true);
    assert.equal(p1.frames.filter((f) => f.t === 'u').length, 0);
  } finally { await srv.close(); }
});

test('resume: a player who drops gets the current state and the moves they missed', async () => {
  const srv = await startServer();
  try {
    const { cfg, p1, p2 } = await twoPlayers(srv);
    await p1.reply(p1.act('place', 0));
    const p2id = p2 === p1 ? '' : (p2.frames.find((f) => f.t === 'welcome')!.me as string);
    p2.close();
    await sleep(30);
    // p2 is away; p1 can't move twice, so p2 comes back and sees seq 1 only, then plays on
    const back = await Client.connect(srv.port, cfg.id, token(cfg.id, p2id), 0);
    const w = await back.wait((f) => f.t === 'welcome');
    assert.equal(w.seq, 1);
    assert.equal(w.missed.length, 1);
    assert.equal(w.missed[0].name, 'place');
    assert.equal(w.s.board[0], p1.frames.find((f) => f.t === 'welcome')!.me);
    assert.equal((await back.reply(back.act('place', 4))).t, 'ok');
  } finally { await srv.close(); }
});

test('limits: payload size and action rate', async () => {
  const srv = await startServer({ actionsPerSec: 2, actionsBurst: 3 });
  try {
    const { p1 } = await twoPlayers(srv);
    p1.send({ t: 'act', id: 'big', name: 'place', p: 'x'.repeat(5000) });
    assert.equal((await p1.wait((f) => f.t === 'error')).code, 'payload_too_large');
    const ids = [1, 2, 3, 4, 5].map((i) => p1.act('place', 9, `r${i}`));
    const replies = await Promise.all(ids.map((id) => p1.reply(id)));
    assert.ok(replies.some((r) => r.err === 'rate_limited'), JSON.stringify(replies));
  } finally { await srv.close(); }
});

test('turn timer runs on the server and moves for an idle player', async () => {
  const srv = await startServer();
  try {
    const code = tictactoe.replace('seconds: 30', 'seconds: 0.3');
    const { a } = await twoPlayers(srv, session(code));
    const u = await a.wait((f) => f.t === 'u' && f.name === 'turn_timeout', 3000);
    assert.equal(u.by, null);
    assert.equal(u.s.board.filter(Boolean).length, 1);
  } finally { await srv.close(); }
});

test('leaving: competitive → the player who left loses; friendly → abandoned', async () => {
  for (const mode of ['competitive', 'friendly'] as const) {
    const srv = await startServer();
    try {
      const { cfg, a, b } = await twoPlayers(srv, session(tictactoe, { mode, reconnectGraceSec: 0.1 as unknown as number }));
      b.close();
      const end = await a.wait((f) => f.t === 'end', 3000);
      if (mode === 'competitive') {
        assert.equal(end.status, 'COMPLETED');
        assert.equal(end.reason, 'forfeit');
        assert.equal(end.result.placements.find((p: any) => p.userId === 'alice').place, 1);
      } else {
        assert.equal(end.status, 'ABANDONED');
        assert.equal(end.reason, 'players_left');
      }
      void cfg;
    } finally { await srv.close(); }
  }
});

test('sleep and wake: an empty session leaves memory and comes back from the store', async () => {
  const srv = await startServer({ sleepAfterMs: 50 });
  try {
    const { cfg, a, b, p1 } = await twoPlayers(srv);
    await p1.reply(p1.act('place', 8));
    a.close(); b.close();
    await sleep(200);
    assert.equal(srv.sessions.count, 0);
    const back = await Client.connect(srv.port, cfg.id, token(cfg.id, 'alice'));
    const w = await back.wait((f) => f.t === 'welcome');
    assert.equal(w.seq, 1);
    assert.ok(w.s.board[8]);
    assert.equal(srv.sessions.count, 1);
  } finally { await srv.close(); }
});

test('a crashing game ends as ABANDONED and says why', async () => {
  const srv = await startServer();
  try {
    const code = `globalThis.__vibesGame = { minPlayers: 2, maxPlayers: 2, setup: () => ({ n: 0 }),
      actions: { boom(state) { state.n++; } }, gameOver(state) { if (state.n > 0) return null.x; } };`;
    const { a, b } = await twoPlayers(srv, session(code));
    a.act('boom', null);
    const end = await b.wait((f) => f.t === 'end');
    assert.equal(end.status, 'ABANDONED');
    assert.equal(end.reason, 'logic_crash');
  } finally { await srv.close(); }
});

test('hidden information: players get only their view, payloads are not broadcast', async () => {
  const srv = await startServer();
  try {
    const code = `globalThis.__vibesGame = { minPlayers: 2, maxPlayers: 2,
      setup: ({ players }) => ({ secret: Object.fromEntries(players.map((p) => [p.userId, null])) }),
      actions: { hide(state, word, { playerId }) { state.secret[playerId] = String(word).slice(0, 20); } },
      view: (state, id) => ({ mine: id ? state.secret[id] : null, others: Object.keys(state.secret).filter((k) => k !== id && state.secret[k]).length }) };`;
    const cfg = session(code, { spectators: true });
    const { a, b } = await twoPlayers(srv, cfg);
    await a.reply(a.act('hide', 'banana'));
    const ub = await b.wait((f) => f.t === 'u');
    assert.equal(ub.p, undefined);
    assert.deepEqual(ub.s, { mine: null, others: 1 });
    const ua = await a.wait((f) => f.t === 'u');
    assert.deepEqual(ua.s, { mine: 'banana', others: 0 });
    const spec = await Client.connect(srv.port, cfg.id, token(cfg.id, 'eve', { role: 'spectator' }));
    const ws = await spec.wait((f) => f.t === 'welcome');
    assert.deepEqual(ws.s, { mine: null, others: 1 });
    assert.equal((await spec.reply(spec.act('hide', 'x'))).err, 'not_a_player');
  } finally { await srv.close(); }
});

test('hidden information survives sleep: views are rebuilt on wake', async () => {
  const srv = await startServer({ sleepAfterMs: 50 });
  try {
    const code = `globalThis.__vibesGame = { minPlayers: 2, maxPlayers: 2,
      setup: () => ({ secret: { alice: 'a-secret', bob: 'b-secret' } }), actions: {},
      view: (state, id) => ({ mine: id ? state.secret[id] : null }) };`;
    const { cfg, a, b } = await twoPlayers(srv, session(code));
    a.close(); b.close();
    await sleep(200);
    assert.equal(srv.sessions.count, 0);
    const back = await Client.connect(srv.port, cfg.id, token(cfg.id, 'bob'));
    assert.deepEqual((await back.wait((f) => f.t === 'welcome')).s, { mine: 'b-secret' });
  } finally { await srv.close(); }
});
