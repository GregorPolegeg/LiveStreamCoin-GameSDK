// The screen. All networking is in the SDK; the logic on the server deals, takes the bets and pays.
// Rendering is keyed: each seat is built once and only what changed is touched, so a move re-animates
// only that player's tag, and the timer bar restarts only when the turn really moves. Cheap on the GPU:
// no blur, no filters, only transform/opacity animate.
import { Vibes, GameActionError, type Change, type PlayerInfo } from '@vibes/games';
import type game from '../logic';
import type { View, SeatView } from '../logic';
import { best, handName } from '../logic/cards';
import { BLINDS, BLINDS_UP, CHIPS, MAX_SEATS, REBUYS, TIMERS, minRaiseTo, type Settings } from '../logic/rules';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number) => (n >= 10000 ? (n / 1000).toFixed(n % 1000 ? 1 : 0) + 'k' : n.toLocaleString('en'));
const COLORS = ['#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#38bdf8', '#fb923c', '#f87171', '#a3e635', '#2dd4bf'];
const STREETS = ['Pre-flop', 'Flop', 'Turn', 'River'];
const MESSAGES: Record<string, string> = {
  not_your_turn: 'Not your turn', not_now: 'Not now', cannot_check: 'There is a bet: call or fold', raise_too_small: 'Raise more',
  not_enough_chips: 'Not enough chips', not_host: 'Only the host can do that', already_started: 'The game already started',
  no_rebuys_left: 'No rebuys left', rate_limited: 'Slow down',
};

let V: View | null = null;
let players: PlayerInfo[] = [];
let busy = false; // a move is on its way
let deck = (() => { try { return localStorage.getItem('vibes-poker-deck') === 'C' ? 'C' : 'A'; } catch { return 'A'; } })();

const vibes = Vibes.init<typeof game>({
  onChange(change) {
    // With view() the server sends View, not State (the SDK types it as State for now: VIB-216).
    const c = change as unknown as Change<View>;
    const prev = V;
    V = c.state;
    players = c.players;
    render(prev);
  },
  onConnection(state) { $('conn').hidden = state !== 'reconnecting'; },
});

const fail = (e: unknown) => { busy = false; if (e instanceof GameActionError) toast(MESSAGES[e.code] ?? e.code); else console.warn(e); controls(); };
let toastT = 0;
function toast(t: string) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = window.setTimeout(() => (el.hidden = true), 1800); }

// ---------- chips & cards ----------

const DEN: [number, string, string?][] = [[5000, '#e23b4e'], [1000, '#e5b21d'], [500, '#6c5cd3'], [100, '#24262d'], [25, '#1f9d55'], [10, '#00A0E5'], [5, '#eef0f4', '#00A0E5'], [1, '#eef0f4', '#9aa3b2']];
const column = (n: number, c: string, e: string | undefined, step: number) =>
  `<span class="cstk" style="--n:${n};--g:${step}px">${Array.from({ length: n }, (_, k) => `<i class="ck" style="--c:${c};${e ? `--e:${e};` : ''}bottom:${k * step}px"></i>`).join('')}</span>`;
/** A bet or the pot: the biggest denominations first, one column each. */
function stacks(v: number, cols = 3, per = 7, step = 3) {
  const out: string[] = [];
  for (const [d, c, e] of DEN) {
    const n = Math.floor(v / d);
    if (n) { out.push(column(Math.min(n, per), c, e, step)); v -= n * d; }
    if (out.length >= cols) break;
  }
  return `<span class="stks">${out.join('')}</span>`;
}
/** A player's own chips: smaller denominations, mixed, so even 5,000 reads as a pile. */
function pile(v: number, cols: number, per: number, step: number) {
  const out: { n: number; c: string; e?: string }[] = [];
  for (const [d, c, e] of DEN) {
    if (d > Math.max(5, v / 6)) continue;
    const n = out.length === cols - 1 ? Math.floor(v / d) : Math.min(Math.floor(v / d), Math.ceil(per * 1.6));
    if (n) { out.push({ n, c, e }); v -= n * d; }
    if (out.length >= cols) break;
  }
  while (out.length && out.length < cols && out[0]!.n > per) { const t = out[0]!; out.splice(1, 0, { ...t, n: Math.floor(t.n / 2) }); t.n = Math.ceil(t.n / 2); }
  return `<span class="stks">${out.map((t) => column(Math.min(t.n, per), t.c, t.e, step)).join('')}</span>`;
}
const suit = (c: string, cls: string) => `<svg class="${cls}"><use href="#${deck}-${c[1]!.toUpperCase()}"/></svg>`;
const cardHtml = (c: string | null, cls = '') => (c
  ? `<div class="card ${'hd'.includes(c[1]!) ? 'red' : ''} ${cls}" data-c="${c}"><span class="r">${c[0] === 'T' ? '10' : c[0]}</span>${suit(c, 's')}${suit(c, 'big')}</div>`
  : `<div class="card back ${cls}"><svg class="logo"><use href="#vlogo"/></svg></div>`);

// ---------- who is who ----------

const info = (id: string) => players.find((p) => p.userId === id);
const colorOf = (i: number) => COLORS[i % COLORS.length]!;
const nameOf = (p: SeatView) => (p.me ? 'You' : info(p.id)?.displayName || p.name);
const amHost = () => !!V && vibes.context?.me.userId === V.host;

// ---------- lobby ----------

function chipRow(id: string, list: readonly number[], key: keyof Settings, label: (v: number, i: number) => string, byIndex = false) {
  const el = $(id), s = V!.settings;
  const html = list.map((v, i) => `<button data-i="${i}" class="${(byIndex ? i : v) === s[key] ? 'on' : ''}">${label(v, i)}</button>`).join('');
  if (el.dataset.h !== html) { el.innerHTML = html; el.dataset.h = html; }
  el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => {
    const i = +b.dataset.i!;
    vibes.actions.settings({ [key]: byIndex ? i : list[i] } as never).catch(fail);
  }));
}
const REBUY_TEXT = {
  none: { ic: '🏁', t: "They're out", d: 'Last one with chips wins. A real tournament.' },
  once: { ic: '↻', t: 'One rebuy each', d: 'Back in once with the starting chips.' },
  any: { ic: '∞', t: 'Rebuy any time', d: 'Never out: top up to the starting chips.' },
} as const;

function renderLobby() {
  const s = V!.settings;
  const host = amHost();
  $('lob').classList.toggle('ro', !host);
  chipRow('o-chips', CHIPS, 'chips', (v) => fmt(v));
  chipRow('o-blinds', BLINDS.map((b) => b[1]), 'blinds', (_, i) => `${fmt(BLINDS[i]![0])}/${fmt(BLINDS[i]![1])}`, true);
  chipRow('o-up', BLINDS_UP, 'up', (m) => (m ? `every ${m} min` : 'never'));
  chipRow('o-timer', TIMERS, 'timer', (t) => `${t} s`);
  const people = V!.seats.length;
  const maxBots = MAX_SEATS - people;
  const botList = Array.from({ length: maxBots + 1 }, (_, i) => i).filter((n) => n <= 5 || n === maxBots);
  chipRow('o-bots', botList, 'bots', (n) => (n ? String(n) : 'none'));
  $('bots-hint').textContent = people < 2 && !s.bots ? 'Playing alone: one bot joins so there is a game.' : 'Bots play the empty seats. They never see your cards.';
  const reb = $('o-rebuy');
  const rh = REBUYS.map((v) => `<button data-v="${v}" class="${s.rebuy === v ? 'on' : ''}"><span class="ic">${REBUY_TEXT[v].ic}</span><div><b>${REBUY_TEXT[v].t}</b><span>${REBUY_TEXT[v].d}</span></div></button>`).join('');
  if (reb.dataset.h !== rh) { reb.innerHTML = rh; reb.dataset.h = rh; }
  reb.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => vibes.actions.settings({ rebuy: b.dataset.v } as never).catch(fail)));
  $('rebuy-hint').textContent = s.rebuy === 'none' ? 'Players who bust can still watch the table.' : s.rebuy === 'once' ? 'A rebuy is the starting chips again, until the blinds have gone up twice.' : 'A rebuy tops you up to the starting chips.';
  const dk = $('o-deck');
  const dh = `<button data-d="A" class="${deck === 'A' ? 'on' : ''}">Soft</button><button data-d="C" class="${deck === 'C' ? 'on' : ''}">Geo</button>`;
  if (dk.dataset.h !== dh) { dk.innerHTML = dh; dk.dataset.h = dh; dk.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => setDeck(b.dataset.d!))); }
  $('seated').textContent = `${people + s.bots} of ${MAX_SEATS}`;
  $('lob-seats').innerHTML = V!.seats.map((p, i) => {
    const pi = info(p.id);
    const av = pi?.avatarUrl ? `style="background:${colorOf(i)} center/cover url('${encodeURI(pi.avatarUrl)}')"` : `style="background:${colorOf(i)}"`;
    return `<span class="seatp"><span class="av" ${av}>${pi?.avatarUrl ? '' : esc(nameOf(p)[0] ?? '?')}</span>${esc(nameOf(p))}${p.id === V!.host ? ' · host' : ''}</span>`;
  }).join('') + Array.from({ length: s.bots }, () => '<span class="seatp"><span class="av" style="background:#2a2c34;color:#fff">🤖</span>Bot</span>').join('');
  $('host-hint').textContent = host ? 'Only you (the host) can change these. Everyone else sees them live.' : 'The host sets the table. You see every change live.';
  const st = $<HTMLButtonElement>('start');
  st.textContent = host ? 'Deal the first hand' : 'Waiting for the host to deal…';
  st.disabled = !host;
  st.onclick = () => vibes.actions.start(null).catch(fail);
}
function setDeck(d: string) {
  deck = d === 'C' ? 'C' : 'A';
  try { localStorage.setItem('vibes-poker-deck', deck); } catch { /* private mode */ }
  $('board').dataset.k = ''; $('myhand').dataset.k = ''; document.querySelectorAll<HTMLElement>('#seats .opp').forEach((el) => (el.dataset.show = ''));
  render(V);
}
const esc = (t: string) => t.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

// ---------- the table ----------

/** Seats around the arc, starting left of me, so the table looks the same from every phone. */
function others() {
  const n = V!.seats.length, you = V!.you;
  const order = Array.from({ length: n }, (_, k) => (you < 0 ? k : (you + 1 + k) % n)).filter((i) => i !== you);
  return order.map((i) => ({ p: V!.seats[i]!, i }));
}

function layout() {
  const v = V!;
  const tiles = others();
  const wrap = $('wrap');
  const W = wrap.clientWidth, H = wrap.clientHeight, wide = W > H * 1.05;
  // the table: an ellipse; phone: seats on the upper arc, the board below; wide: seats all around
  const rx = wide ? Math.min(W * 0.42, H * 0.85) : W * 0.39, ry = wide ? H * 0.4 : H * 0.34;
  const cx = W / 2, cy = wide ? H * 0.52 : H * 0.4;
  wrap.style.setProperty('--boardTop', (wide ? cy - 120 : cy + ry * 0.18) + 'px');
  const rail = $('rail'); rail.style.width = rx * 1.62 + 'px'; rail.style.height = ry * 1.5 + 'px'; rail.style.top = cy + 'px';
  const n = tiles.length, from = Math.PI * (wide ? 0.88 : 1.0), to = Math.PI * (wide ? 2.12 : 2.0);
  const host = $('seats');
  const key = tiles.map((t) => t.p.id).join();
  if (host.dataset.n !== key) {
    host.innerHTML = tiles.map(({ i }) => `<div class="opp" data-i="${i}"><div class="face"><span class="av"></span></div><div class="plate"><b></b><span class="sr"><span class="pile"></span><span class="stk"></span></span><div class="bar"></div></div></div>`).join('');
    host.dataset.n = key;
  }
  const winners = new Set(v.result?.wins.map((w) => w.seat) ?? []);
  tiles.forEach(({ p, i }, k) => {
    const el = host.querySelector<HTMLElement>(`[data-i="${i}"]`)!;
    const ang = n === 1 ? Math.PI * 1.5 : from + (to - from) * (k / (n - 1));
    // the top seat stays clear of the header on short screens
    const x = cx + Math.cos(ang) * rx, y = Math.max(cy + Math.sin(ang) * ry, 52);
    const pos = `${Math.round(x)},${Math.round(y)}`;
    if (el.dataset.pos !== pos) { el.style.left = x + 'px'; el.style.top = y + 'px'; el.dataset.pos = pos; }
    const gone = p.left || (p.out && p.stack <= 0);
    el.classList.toggle('folded', p.folded); el.classList.toggle('out', gone); el.classList.toggle('turn', v.turn === i);
    const av = el.querySelector<HTMLElement>('.av')!;
    const pi = info(p.id);
    const avKey = `${nameOf(p)}|${pi?.avatarUrl ?? ''}`;
    if (av.dataset.k !== avKey) {
      av.dataset.k = avKey;
      av.textContent = pi?.avatarUrl ? '' : p.bot ? '🤖' : (nameOf(p)[0] ?? '?');
      av.classList.toggle('bot', p.bot);
      av.style.background = pi?.avatarUrl ? `${colorOf(i)} center/cover url('${encodeURI(pi.avatarUrl)}')` : p.bot ? '#2a2c34' : colorOf(i);
      el.querySelector('.plate b')!.textContent = nameOf(p);
    }
    const stk = p.left ? 'left' : gone ? (p.rebuyUntil ? 'rebuying…' : 'out') : fmt(p.stack);
    const stkEl = el.querySelector('.stk')!; if (stkEl.textContent !== stk) stkEl.textContent = stk;
    const pl = el.querySelector<HTMLElement>('.pile')!, pk = gone ? '' : String(p.stack);
    if (pl.dataset.v !== pk) { pl.innerHTML = pk && p.stack ? pile(p.stack, 3, 5, 2) : ''; pl.dataset.v = pk; }
    const face = el.querySelector('.face')!;
    const d = face.querySelector('.d'); if (v.dealer === i && !d) face.insertAdjacentHTML('beforeend', '<span class="d">D</span>'); else if (v.dealer !== i && d) d.remove();
    const holding = p.cards.length > 0 && !p.folded && !p.out && !p.show;
    const ih = face.querySelector('.inhand'); if (holding && !ih) face.insertAdjacentHTML('beforeend', '<span class="inhand"></span>'); else if (!holding && ih) ih.remove();
    const tagKey = p.tag ? `${p.tag}|${p.tagKind}` : '';
    if (el.dataset.tag !== tagKey) {
      el.querySelector('.st')?.remove();
      if (p.tag) el.insertAdjacentHTML('afterbegin', `<span class="st ${p.tagKind === 'blind' ? '' : p.tagKind}">${esc(p.tag)}</span>`);
      el.dataset.tag = tagKey;
    }
    const shown = p.show && p.cards.every(Boolean);
    const showKey = shown ? p.cards.join() + (winners.has(i) ? '*' : '') : '';
    if (el.dataset.show !== showKey) {
      el.querySelector('.mini')?.remove();
      if (showKey) face.insertAdjacentHTML('afterend', `<div class="mini">${p.cards.map((c) => cardHtml(c, winners.has(i) ? 'win' : '')).join('')}</div>`);
      el.dataset.show = showKey;
    }
    const betKey = p.bet ? String(p.bet) : '';
    let bt = el.querySelector<HTMLElement>('.bt');
    if (betKey && !bt) { el.insertAdjacentHTML('beforeend', '<span class="bt"></span>'); bt = el.querySelector<HTMLElement>('.bt'); }
    if (!betKey && bt) bt.remove();
    if (betKey && bt) {
      const bx = (cx - x) * 0.34, by = (cy - y) * 0.3;
      bt.style.left = `calc(50% + ${bx}px)`; bt.style.top = `calc(50% + ${by}px)`; bt.style.transform = 'translate(-50%,-50%)';
      if (bt.dataset.v !== betKey) { bt.innerHTML = `${stacks(p.bet, 2, 6)}<b>${fmt(p.bet)}</b>`; bt.dataset.v = betKey; }
    }
    timerBar(el.querySelector<HTMLElement>('.bar')!, v.turn === i);
  });
  const inMiddle = v.seats.reduce((s, p) => s + p.bet, 0);
  $('potv').textContent = fmt(v.pot + inMiddle);
  const pc = $('potc'); if (pc.dataset.v !== String(v.pot)) { pc.innerHTML = v.pot ? stacks(v.pot, 4, 8) : ''; pc.dataset.v = String(v.pot); }
  renderBoard();
  mine();
  $('sub').textContent = `Hand ${v.hand || 1} · ${STREETS[v.street] ?? ''}`;
  $('lvl').textContent = `Blinds ${fmt(v.blindsNow[0])}/${fmt(v.blindsNow[1])}`;
  $('end').hidden = !amHost() || v.phase !== 'play';
  banner();
  controls();
  bust();
}

/** The turn bar: one CSS animation, started once per turn from the server deadline. */
function timerBar(bar: HTMLElement, on: boolean) {
  const v = V!;
  const tk = on ? `${v.seq}` : '';
  if (bar.dataset.tk === tk) return;
  bar.dataset.tk = tk;
  if (!on) { bar.innerHTML = ''; return; }
  const total = v.settings.timer * 1000, left = Math.max(0, v.deadline - vibes.time.now());
  bar.innerHTML = `<i style="animation-duration:${total}ms;animation-delay:${left - total}ms"></i>`;
}

function renderBoard() {
  const v = V!;
  const five = new Set(v.result && !v.result.byFold ? v.result.five : []);
  const k = `${v.hand}|${v.board.join()}|${[...five].join()}|${deck}`;
  const el = $('board');
  if (el.dataset.k === k) return;
  const had = el.dataset.hand === String(v.hand) ? Number(el.dataset.n || 0) : 0;
  el.dataset.k = k; el.dataset.hand = String(v.hand); el.dataset.n = String(v.board.length);
  el.innerHTML = [0, 1, 2, 3, 4].map((i) => {
    const c = v.board[i];
    if (!c) return '<div class="card slot"></div>';
    return cardHtml(c, `${i >= had ? 'deal' : ''} ${five.size ? (five.has(c) ? 'win' : 'dim') : ''}`);
  }).join('');
  el.querySelectorAll('.deal').forEach((c, j) => setTimeout(() => c.classList.remove('deal'), 80 + j * 110));
}

function mine() {
  const v = V!;
  document.body.classList.toggle('spect', v.you < 0);
  const me = v.seats[v.you];
  if (!me) return;
  const mb = $('mybt'), mk = me.bet ? String(me.bet) : '';
  if (mb.dataset.v !== mk) { mb.hidden = !mk; mb.classList.remove('fly'); mb.style.transform = ''; mb.innerHTML = mk ? `${stacks(me.bet, 2, 6)}<b>${fmt(me.bet)}</b>` : ''; mb.dataset.v = mk; }
  $('mystack').textContent = me.stack > 0 || !me.out ? fmt(me.stack) : 'out';
  const mp = $('mypile'); if (mp.dataset.v !== String(me.stack)) { mp.innerHTML = me.stack ? pile(me.stack, 4, 6, 2.5) : ''; mp.dataset.v = String(me.stack); }
  $('mine').classList.toggle('turn', v.turn === v.you);
  $('mydealer').style.display = v.dealer === v.you ? 'grid' : 'none';
  const won = v.result?.wins.find((w) => w.seat === v.you);
  $('mybet').innerHTML = me.bet ? `In<b>${fmt(me.bet)}</b>` : won ? `<b style="color:var(--gold)">+${fmt(won.amount)}</b>` : '';
  timerBar($('mybar'), v.turn === v.you);
  const cards = me.cards.filter((c): c is string => !!c);
  const hk = `${v.hand}|${cards.join()}|${!!won}|${me.folded}|${deck}`;
  const hand = $('myhand');
  if (hand.dataset.k !== hk) {
    const fresh = hand.dataset.hand !== String(v.hand);
    hand.dataset.k = hk; hand.dataset.hand = String(v.hand);
    hand.innerHTML = cards.length && !me.out ? cards.map((c) => cardHtml(c, `${fresh ? 'deal' : ''} ${won && !v.result?.byFold ? 'win' : me.folded ? 'dim' : ''}`)).join('') : '';
    hand.querySelectorAll('.deal').forEach((c, j) => setTimeout(() => c.classList.remove('deal'), 60 + j * 140));
  }
  const known = cards.length ? [...cards, ...v.board] : [];
  $('strength').textContent = me.folded || me.out ? '' : known.length >= 5 ? handName(best(known).score) : cards.length === 2 && cards[0]![0] === cards[1]![0] ? 'Pocket pair' : '';
}

function banner() {
  const v = V!, r = v.result;
  const on = !!r && v.phase === 'play';
  $('banner').classList.toggle('on', on);
  if (!r || !on) return;
  const names = r.wins.map((w) => (w.seat === v.you ? 'You' : nameOf(v.seats[w.seat]!)));
  const amount = r.wins.reduce((s, w) => s + w.amount, 0);
  $('bn-t').textContent = `${names.join(' & ')} ${r.wins.length > 1 ? 'split' : names[0] === 'You' ? 'win' : 'wins'} ${fmt(amount)}`;
  $('bn-s').textContent = r.byFold ? 'Everyone else folded' : r.wins[0]?.hand ?? '';
}

// ---------- my controls ----------

let rPick = 0;
const me = () => (V ? V.seats[V.you] : undefined);
const myTurn = () => !!V && V.phase === 'play' && V.turn === V.you && !V.pending && !!me() && !busy;
const rmin = () => minRaiseTo(V as never, V!.you);
const rmax = () => me()!.bet + me()!.stack;
const raiseTo = () => Math.round(rmin() + ((rmax() - rmin()) * rPick) / 100);
const toCall = () => Math.min(V!.bet - me()!.bet, me()!.stack);
const potNow = () => V!.pot + V!.seats.reduce((s, p) => s + p.bet, 0);

function controls() {
  if (!V || V.phase !== 'play') return;
  const m = me();
  const mineNow = myTurn();
  $('actions').style.display = mineNow ? 'grid' : 'none';
  $('waiting').style.display = mineNow ? 'none' : 'grid';
  if (!mineNow) $('raise').classList.remove('on');
  const t = V.seats[V.turn];
  $('waiting').textContent = !m ? (t ? `${nameOf(t)} is thinking…` : 'Watching') : m.out ? (m.left ? 'You left' : "You're watching")
    : m.folded ? 'You folded · next hand soon' : V.pending ? '' : t && V.turn !== V.you ? `${nameOf(t)} is thinking…` : busy ? '…' : '';
  if (!mineNow || !m) return;
  const call = toCall();
  const open = $('raise').classList.contains('on');
  $('a-call').innerHTML = call > 0 ? (call >= m.stack ? `<span class="k">All-in</span><small>${fmt(call)}</small>` : `<span class="k">Call</span><small>${fmt(call)}</small>`) : '<span class="k">✓ Check</span>';
  $('a-call').classList.toggle('allin', call > 0 && call >= m.stack);
  $('a-fold').innerHTML = open ? '<span class="k">Cancel</span>' : '<span class="k">✕ Fold</span>';
  const canRaise = m.stack > call;
  $<HTMLButtonElement>('a-raise').disabled = !canRaise;
  const word = V.bet ? 'Raise' : 'Bet';
  const to = raiseTo();
  $('a-raise').innerHTML = open ? `<span class="k">${to >= rmax() ? 'All-in' : word}</span><small>${fmt(to)}</small>` : `<span class="k">${word} ▴</span><small>from ${fmt(rmin())}</small>`;
  $('a-raise').classList.toggle('allin', open && to >= rmax());
}
function syncRaise() {
  const to = raiseTo();
  $('ramt').textContent = fmt(to);
  $('rinfo').textContent = to >= rmax() ? 'all your chips' : `${Math.round(((to - me()!.bet) / Math.max(1, potNow())) * 100)}% of the pot`;
  const sl = $<HTMLInputElement>('slider'); sl.value = String(rPick); sl.style.setProperty('--p', rPick + '%');
  $('rmin').textContent = 'min ' + fmt(rmin()); $('rmax').textContent = 'max ' + fmt(rmax());
  controls();
}
const setTo = (target: number) => { rPick = Math.max(0, Math.min(100, ((target - rmin()) / Math.max(1, rmax() - rmin())) * 100)); syncRaise(); };
const clearSeg = () => $('seg').querySelectorAll('button').forEach((b) => b.classList.remove('on'));
function send(kind: 'fold' | 'check' | 'call' | 'raise', to?: number) {
  if (!myTurn()) return;
  busy = true;
  $('raise').classList.remove('on');
  controls();
  vibes.actions.move(kind === 'raise' ? { kind, to: to! } : { kind }).then(() => { busy = false; controls(); }, fail);
}
$('slider').oninput = () => { rPick = +$<HTMLInputElement>('slider').value; clearSeg(); syncRaise(); };
$('seg').querySelectorAll<HTMLButtonElement>('[data-f]').forEach((b) => (b.onclick = () => {
  const f = b.dataset.f!;
  $('seg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  setTo(f === 'all' ? rmax() : V!.bet + Math.round(potNow() * +f));
}));
$('minus').onclick = () => setTo(raiseTo() - V!.blindsNow[1]);
$('plus').onclick = () => setTo(raiseTo() + V!.blindsNow[1]);
$('a-fold').onclick = () => { if ($('raise').classList.contains('on')) { $('raise').classList.remove('on'); controls(); } else send('fold'); };
$('a-call').onclick = () => send(toCall() > 0 ? 'call' : 'check');
$('a-raise').onclick = () => { if (!$('raise').classList.contains('on')) { rPick = 0; clearSeg(); $('raise').classList.add('on'); syncRaise(); } else send('raise', raiseTo()); };
$('end').onclick = () => { if (confirm('End the game for everyone? Chips in the middle go back.')) vibes.actions.end(null).catch(fail); };

// ---------- busted: rebuy or watch ----------

let bustTimer = 0;
function bust() {
  const m = me();
  const on = !!m && V!.phase === 'play' && m.stack <= 0 && m.rebuyUntil > vibes.time.now() && !m.left;
  $('bust').classList.toggle('on', on);
  clearInterval(bustTimer);
  if (!on || !m) return;
  $('bust-p').textContent = V!.settings.rebuy === 'once' ? 'You can buy back in once with the starting chips.' : 'Top up to the starting chips and keep playing.';
  const tick = () => { const s = Math.max(0, Math.ceil((m.rebuyUntil - vibes.time.now()) / 1000)); $('bust-t').textContent = `${s} s to decide`; };
  tick(); bustTimer = window.setInterval(tick, 500);
}
$('rebuy').onclick = () => vibes.actions.rebuy(null).catch(fail);
$('watch').onclick = () => vibes.actions.watch(null).catch(fail);

// ---------- chips moving ----------

function flyTo(el: Element, target: Element) {
  const a = el.getBoundingClientRect(), b = target.getBoundingClientRect();
  return [b.left + b.width / 2 - (a.left + a.width / 2), b.top + b.height / 2 - (a.top + a.height / 2)] as const;
}
/** The bets slide into the pot (end of a street). */
function sweep() {
  const pot = $('pot');
  document.querySelectorAll<HTMLElement>('#seats .bt, #mybt:not([hidden])').forEach((el) => {
    const [dx, dy] = flyTo(el, pot);
    el.style.transform = `${el.id ? 'translate(-50%,0)' : 'translate(-50%,-50%)'} translate(${dx}px,${dy}px) scale(.6)`;
    el.classList.add('fly');
  });
}
/** The pot slides to the winner(s). */
function payOut(v: View) {
  const from = $('pot').getBoundingClientRect();
  for (const w of v.result?.wins ?? []) {
    const seat = w.seat === v.you ? $('mine') : document.querySelector(`#seats [data-i="${w.seat}"] .face`);
    if (!seat || !from.width) continue;
    const f = document.createElement('div');
    f.className = 'flyer'; f.innerHTML = stacks(w.amount, 4, 8);
    f.style.left = from.left + 'px'; f.style.top = from.top + 'px';
    document.body.appendChild(f);
    const to = seat.getBoundingClientRect();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      f.style.transform = `translate(${to.left + to.width / 2 - from.left - from.width / 2}px,${to.top + to.height / 2 - from.top - from.height / 2}px) scale(.7)`;
      f.style.opacity = '0';
    }));
    setTimeout(() => f.remove(), 650);
  }
}

// ---------- the end ----------

function renderOver() {
  const v = V!;
  const rows = v.seats.filter((p) => !p.bot).map((p) => ({ p, k: p.stack > 0 && !p.left ? 1e12 + p.stack : p.bustHand })).sort((a, b) => b.k - a.k);
  const first = rows[0]?.p;
  $('over-t').textContent = !first ? 'Game over' : first.me ? 'You win the game 🏆' : `${nameOf(first)} wins the game 🏆`;
  $('over-s').textContent = v.endedBy === 'host' ? 'The host ended the game' : `${v.hand} hands played`;
  $('over-list').innerHTML = rows.map(({ p }, i) => `<li><span class="pl">${i + 1}</span><b>${esc(nameOf(p))}</b><span>${p.stack > 0 ? fmt(p.stack) : 'out'}</span></li>`).join('');
  $('over').classList.add('on');
}
$('again').onclick = () => vibes.rematch({ ...V!.settings, lobby: false });
$('new-settings').onclick = () => vibes.rematch({ ...V!.settings });

// ---------- render ----------

function render(prev: View | null) {
  const v = V;
  if (!v) return;
  $('lobby').classList.toggle('on', v.phase === 'lobby');
  $('table').classList.toggle('on', v.phase !== 'lobby');
  if (v.phase === 'lobby') return renderLobby();
  // chips move before the new picture: the bets slide into the pot, then the pot to the winners
  const paid = !!prev && !!v.result && v.result.hand === v.hand && prev.result?.hand !== v.hand;
  if (prev && prev.phase === 'play' && prev.hand === v.hand && prev.seats.some((p) => p.bet) && v.seats.every((p) => !p.bet)) {
    sweep();
    setTimeout(() => { if (!V) return; if (paid) payOut(V); finish(); }, 400);
    return;
  }
  if (paid) payOut(v);
  finish();
}
function finish() {
  layout();
  if (V!.phase === 'done') renderOver();
  else $('over').classList.remove('on');
}
addEventListener('resize', () => V && V.phase !== 'lobby' && layout());
