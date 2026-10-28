// The screen. All networking is in the SDK; the logic on the server decides what is right.
// Country names come from the player's own language (Intl.DisplayNames), so the game is translated for free.
import { Vibes, GameActionError, type Change, type PlayerInfo } from '@vibes/games';
import type game from '../logic';
import type { Pool, View } from '../logic';
import { ALL } from '../logic/countries';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const flagEl = el<HTMLImageElement>('flag');
const optionsEl = el('options');
const hintEl = el('hint');
const barEl = el('bar-fill');
const typeForm = el<HTMLFormElement>('type-form');
const typeInput = el<HTMLInputElement>('type-input');
const suggestEl = el('suggest');
const picksEl = el('picks');

const COLORS = ['#a78bfa', '#34d399', '#f472b6', '#fbbf24', '#38bdf8', '#fb923c', '#f87171', '#a3e635', '#2dd4bf', '#c084fc', '#facc15', '#60a5fa', '#e879f9', '#4ade80', '#fda4af', '#93c5fd'];
const POOL_NAMES: Record<Pool, string> = { famous: '⭐ Famous', all: '🌍 All', europe: 'Europe', asia: 'Asia', africa: 'Africa', americas: 'Americas', oceania: 'Oceania' };
const SECONDS = [5, 10, 15, 20, 30, 45, 60];
const ROUNDS = [5, 10, 15, 20, 30];
const MESSAGES: Record<string, string> = {
  already_started: 'The game already started',
  already_answered: 'You already answered',
  not_now: 'Too late for this flag',
  bad_option: 'Pick a country from the list',
  rate_limited: 'Slow down',
};

let last: Change<View> | null = null;
let shownFlag = '';

const vibes = Vibes.init<typeof game>({
  onChange(change) {
    // With view() the server sends View, not State (the SDK types it as State for now: VIB-216).
    last = change as unknown as Change<View>;
    render(last);
  },
  onConnection(state) {
    el('banner').hidden = state !== 'reconnecting';
  },
});

const fail = (e: unknown) => {
  if (e instanceof GameActionError) toast(MESSAGES[e.code] ?? e.code);
  else console.warn(e);
};

// ---------- country names (player's language + English, for typing) ----------

const locale = () => vibes.context?.locale ?? navigator.language ?? 'en';
let names: { local: Intl.DisplayNames | null; en: Intl.DisplayNames | null } | null = null;
function displayNames(lang: string): Intl.DisplayNames | null {
  try { return new Intl.DisplayNames([lang, 'en'], { type: 'region' }); } catch { return null; }
}
function countryName(code: string): string {
  names ??= { local: displayNames(locale()), en: displayNames('en') };
  try { return names.local?.of(code.toUpperCase()) ?? code.toUpperCase(); } catch { return code.toUpperCase(); }
}

/** What people actually type. */
const ALIASES: Record<string, string[]> = {
  us: ['usa', 'america', 'united states', 'zda', 'amerika'], gb: ['uk', 'england', 'britain', 'great britain', 'anglija', 'velika britanija'],
  ae: ['uae', 'emirates'], cz: ['czechia', 'czech republic', 'ceska'], ci: ['ivory coast', 'cote divoire'], kr: ['south korea', 'korea'],
  kp: ['north korea'], va: ['vatican'], mk: ['macedonia'], sz: ['swaziland'], nl: ['holland'], mm: ['burma'], tl: ['east timor'],
  cd: ['dr congo', 'drc'], cg: ['congo'], ba: ['bosnia'],
};

const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
let searchIndex: { code: string; label: string; keys: string[] }[] | null = null;
function index() {
  if (searchIndex) return searchIndex;
  names ??= { local: displayNames(locale()), en: displayNames('en') };
  searchIndex = ALL.map((code) => {
    const label = countryName(code);
    let en = label;
    try { en = names!.en?.of(code.toUpperCase()) ?? label; } catch { /* keep */ }
    return { code, label, keys: [...new Set([label, en, ...(ALIASES[code] ?? [])].map(norm))] };
  });
  return searchIndex;
}

/** Best matches from 2 letters on: name starts with it, then a word starts with it, then it's inside. */
function suggestions(q: string, max = 5): { code: string; label: string }[] {
  const n = norm(q);
  if (n.length < 2) return [];
  const rank = (k: string) => (k.startsWith(n) ? 0 : k.split(' ').some((w) => w.startsWith(n)) ? 1 : k.includes(n) ? 2 : 9);
  return index()
    .map((c) => ({ ...c, r: Math.min(...c.keys.map(rank)) }))
    .filter((c) => c.r < 9)
    .sort((a, b) => a.r - b.r || a.label.localeCompare(b.label))
    .slice(0, max);
}

const exactMatch = (q: string) => index().find((c) => c.keys.includes(norm(q)))?.code ?? null;

// ---------- players ----------

const playerIds = (s: View) => Object.keys(s.scores);
const playerName = (list: PlayerInfo[], id: string, me: string) =>
  id === me ? 'You' : list.find((p) => p.userId === id)?.displayName ?? id;
const colorOf = (list: PlayerInfo[], id: string) => {
  const p = list.find((x) => x.userId === id);
  return p?.color ?? COLORS[(p?.seat ?? 0) % COLORS.length]!;
};

// ---------- lobby: anyone sets the game up ----------

function chips(id: string, values: readonly (string | number)[], label: (v: never) => string, key: 'seconds' | 'rounds' | 'pool') {
  for (const v of values) {
    const b = document.createElement('button');
    b.dataset.v = String(v);
    b.textContent = label(v as never);
    b.onclick = () => vibes.actions.settings({ [key]: v }).catch(fail);
    el(id).append(b);
  }
}
chips('set-seconds', SECONDS, (v: number) => `${v} s`, 'seconds');
chips('set-rounds', ROUNDS, (v: number) => String(v), 'rounds');
chips('set-pool', Object.keys(POOL_NAMES), (v: Pool) => POOL_NAMES[v], 'pool');
el('set-mode').querySelectorAll('button').forEach((b) => {
  b.onclick = () => vibes.actions.settings({ mode: b.dataset.v! }).catch(fail);
});
el('start').onclick = () => vibes.actions.start(null).catch(fail);

function renderLobby(c: Change<View>) {
  const { settings, changedBy } = c.state;
  const on = (id: string, v: string | number) => el(id).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
  on('set-mode', settings.mode);
  on('set-seconds', settings.seconds);
  on('set-rounds', settings.rounds);
  on('set-pool', settings.pool);
  el('changed').textContent = changedBy ? `${playerName(c.players, changedBy, c.me)} changed the settings` : ' ';
  const ids = playerIds(c.state);
  el('lobby-players').innerHTML = ids.map((id) => {
    const p = c.players.find((x) => x.userId === id);
    const name = playerName(c.players, id, c.me);
    return `<li class="${id === c.me ? 'me' : ''} ${p && !p.connected ? 'off' : ''}"><span class="av" style="background:${colorOf(c.players, id)}">${esc(name[0] ?? '?')}</span>${esc(name)}</li>`;
  }).join('');
  el('start').textContent = ids.length > 1 ? `Start (${ids.length} players)` : 'Start';
}

// ---------- answering: cards ----------

const buttons = Array.from({ length: 4 }, (_, i) => {
  const b = document.createElement('button');
  b.onclick = () => {
    const code = last?.state.options[i];
    if (!code) return;
    b.classList.add('picked'); // instant feedback; the server confirms
    buttons.forEach((x) => (x.disabled = true));
    vibes.actions.answer(code).catch((e) => { b.classList.remove('picked'); if (last) render(last); fail(e); });
  };
  optionsEl.append(b);
  return b;
});

// ---------- answering: typing ----------

let sel = 0;
let shown: { code: string; label: string }[] = [];
function renderSuggest() {
  shown = suggestions(typeInput.value);
  sel = Math.min(sel, Math.max(0, shown.length - 1));
  suggestEl.innerHTML = shown.map((s, i) => `<li data-code="${s.code}" class="${i === sel ? 'sel' : ''}">${esc(s.label)}</li>`).join('');
}
typeInput.addEventListener('input', () => { sel = 0; renderSuggest(); });
typeInput.addEventListener('keydown', (e) => {
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && shown.length) {
    e.preventDefault();
    sel = (sel + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
    renderSuggest();
  }
});
suggestEl.addEventListener('pointerdown', (e) => {
  const li = (e.target as HTMLElement).closest('li');
  if (!li) return;
  e.preventDefault();
  send(li.dataset.code!);
});
typeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = exactMatch(typeInput.value) ?? shown[sel]?.code ?? null;
  if (!code) return toast(norm(typeInput.value).length < 2 ? 'Type a country' : 'No country like that');
  send(code);
});
function send(code: string) {
  typeInput.value = countryName(code);
  suggestEl.innerHTML = '';
  shown = [];
  typeInput.disabled = true;
  vibes.actions.answer(code).catch((e) => { typeInput.disabled = false; fail(e); });
}

// ---------- the game ----------

function render(c: Change<View>) {
  const s = c.state;
  if (!s) return;
  const lobby = s.phase === 'lobby';
  el('lobby').hidden = !lobby;
  el('game').hidden = lobby;
  if (lobby) { renderLobby(c); el('end').hidden = true; return; }

  const me = c.me;
  const mine = s.answers[me];
  const reveal = s.phase !== 'question';
  const text = s.settings.mode === 'text';
  const limit = s.settings.seconds * 1000;
  const ids = playerIds(s).sort((a, b) => (s.scores[b] ?? 0) - (s.scores[a] ?? 0));

  el('round').textContent = `${Math.min(s.round + 1, s.settings.rounds)} / ${s.settings.rounds} · ${POOL_NAMES[s.settings.pool]}${text ? ' · ⌨️' : ''}`;
  el('me-score').textContent = String(s.scores[me] ?? 0);

  if (s.flag !== shownFlag) {
    shownFlag = s.flag;
    flagEl.src = `flags/${s.flag}.svg`;
    flagEl.classList.remove('pop'); void flagEl.offsetWidth; flagEl.classList.add('pop');
    typeInput.value = '';
    typeInput.disabled = false;
    suggestEl.innerHTML = '';
    shown = [];
    if (text && s.phase === 'question') typeInput.focus({ preventScroll: true });
  }

  barEl.style.width = `${s.phase === 'question' ? (s.left / limit) * 100 : 0}%`;
  barEl.classList.toggle('low', s.phase === 'question' && s.left <= 3000);

  // Cards: who picked what shows on the cards after the reveal.
  optionsEl.hidden = text;
  if (!text) {
    const pickers: Record<string, string[]> = {};
    if (reveal) for (const [id, a] of Object.entries(s.answers)) (pickers[a.pick] ??= []).push(id);
    s.options.forEach((code, i) => {
      const b = buttons[i]!;
      b.textContent = countryName(code);
      b.disabled = reveal || !!mine || c.status !== 'RUNNING' || !(me in s.scores);
      b.className = '';
      if (mine?.pick === code) b.classList.add('picked');
      if (reveal) {
        b.classList.add(code === s.answer ? 'right' : mine?.pick === code ? 'wrong' : 'dim');
        const who = pickers[code];
        if (who?.length) {
          const tags = document.createElement('span');
          tags.className = 'who';
          tags.innerHTML = who.map((id) => `<i style="color:${colorOf(c.players, id)}">${esc(playerName(c.players, id, me))}</i>`).join('');
          b.append(tags);
        }
      }
    });
  }

  // Typing: the field while the flag is up, then everyone's answer in a list.
  typeForm.hidden = !text || reveal;
  if (text && !reveal && mine) { typeInput.disabled = true; typeInput.value = countryName(mine.pick); }
  el<HTMLButtonElement>('type-send').disabled = !!mine;
  picksEl.hidden = !text || !reveal || !s.answer;
  if (text && reveal && s.answer) {
    picksEl.innerHTML = `<li class="answer">${esc(countryName(s.answer))}</li>` + ids.map((id) => {
      const a = s.answers[id];
      const ok = a?.pick === s.answer;
      return `<li class="${ok ? 'good' : 'bad'}"><span>${esc(playerName(c.players, id, me))}: ${a ? esc(countryName(a.pick)) : '—'}</span><b>${ok ? `+${a!.points}` : '✗'}</b></li>`;
    }).join('');
  }

  if (s.phase === 'question') {
    hintEl.className = 'hint';
    const waiting = ids.filter((id) => !s.gone.includes(id) && !s.answered.includes(id)).length;
    hintEl.textContent = mine ? (waiting ? `Waiting for ${waiting} more…` : 'Locked in') : text ? 'Type the country' : 'Which country is this?';
  } else if (s.answer) {
    const right = mine?.pick === s.answer;
    hintEl.className = 'hint ' + (right ? 'good' : 'bad');
    hintEl.textContent = right ? `Right! +${mine!.points}${(s.streaks[me] ?? 0) > 1 ? ` · 🔥 ${s.streaks[me]} in a row` : ''}` : mine ? `It was ${countryName(s.answer)}` : `Too slow: ${countryName(s.answer)}`;
  }

  // Players: score, and ✓ when they've answered (who is right shows only at the reveal).
  el('players').innerHTML = ids.map((id) => {
    const p = c.players.find((x) => x.userId === id);
    const name = playerName(c.players, id, me);
    let tag = '';
    if (s.phase === 'question' && s.answered.includes(id)) tag = '<span class="tag done">✓</span>';
    if (reveal && s.answer) {
      const a = s.answers[id];
      tag = a?.pick === s.answer ? `<span class="tag good">+${a.points}</span>` : '<span class="tag bad">✗</span>';
    }
    const off = s.gone.includes(id) || (p && !p.connected);
    return `<li class="${id === me ? 'me' : ''} ${off ? 'off' : ''}"><span class="av" style="background:${colorOf(c.players, id)}">${esc(name[0] ?? '?')}</span>${esc(name)} <span class="pts">${s.scores[id] ?? 0}</span>${tag}</li>`;
  }).join('');

  // The end.
  if (c.status === 'COMPLETED' || c.status === 'ABANDONED') {
    const places = c.result?.placements ?? [];
    const myPlace = places.find((p) => p.userId === me)?.place;
    el('end-title').textContent = c.status === 'ABANDONED' ? 'Game ended'
      : c.result?.draw ? "It's a tie!"
      : ids.length === 1 ? `${s.right[me] ?? 0} / ${s.settings.rounds} right`
      : myPlace === 1 ? '🏆 You won!' : `You're #${myPlace ?? '?'}`;
    el('end-list').innerHTML = ids.map((id) => {
      const place = places.find((p) => p.userId === id)?.place ?? 1;
      const medal = ['🥇', '🥈', '🥉'][place - 1] ?? `#${place}`;
      return `<li class="${id === me ? 'me' : ''}"><span class="place">${medal}</span><span>${esc(playerName(c.players, id, me))}<br><small>${s.right[id] ?? 0} / ${s.settings.rounds} right</small></span><b>${s.scores[id] ?? 0}</b></li>`;
    }).join('');
    el('end-actions').hidden = c.status !== 'COMPLETED' || !(me in s.scores);
    el('end').hidden = false;
  } else {
    el('end').hidden = true;
  }
}

// After the end: the next game with the same players. VIBES starts it right away and moves everyone who taps here
// into it. Play again keeps the settings and skips the lobby; New settings opens the lobby with them filled in.
function again(skipLobby: boolean) {
  const s = last?.state;
  if (!s) return;
  el<HTMLButtonElement>('again').disabled = el<HTMLButtonElement>('new-settings').disabled = true;
  vibes.rematch({ ...s.settings, ...(skipLobby ? { lobby: false } : {}) });
  setTimeout(() => { el<HTMLButtonElement>('again').disabled = el<HTMLButtonElement>('new-settings').disabled = false; }, 4000);
}
el('again').onclick = () => again(true);
el('new-settings').onclick = () => again(false);

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string) {
  const t = el('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
}

const esc = (t: string) => t.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
