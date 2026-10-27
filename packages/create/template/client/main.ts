// The screen. All networking is in the SDK: it gets the session from VIBES, connects,
// reconnects and resends. The logic on the server decides what is allowed.
import { Vibes, GameActionError, type Change, type PlayerInfo } from '@vibes/games';
import type game from '../logic';
import type { State } from '../logic';
import { winningLine } from '../logic/rules'; // pure helpers can be shared with the logic

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const boardEl = el('board');
const statusEl = el('status');
const timerEl = el('timer');
const playersEl = el('players');
const bannerEl = el('banner');
const toastEl = el('toast');
const endEl = el('end');

const MESSAGES: Record<string, string> = {
  not_your_turn: 'Not your turn',
  taken: 'That cell is taken',
  bad_cell: 'Pick a cell on the board',
  session_over: 'The game is over',
  rate_limited: 'Slow down',
};

let last: Change<State> | null = null;

const vibes = Vibes.init<typeof game>({
  onChange(change) {
    last = change;
    render(change);
  },
  onConnection(state) {
    bannerEl.hidden = state !== 'reconnecting';
  },
});

// Nine cells, created once.
const cells = Array.from({ length: 9 }, (_, i) => {
  const b = document.createElement('button');
  b.setAttribute('aria-label', `Cell ${i + 1}`);
  b.onclick = () => {
    vibes.actions.place(i).catch((e: unknown) => toast(e instanceof GameActionError ? e.code : 'error'));
  };
  boardEl.append(b);
  return b;
});

const nameOf = (players: PlayerInfo[], userId: string | null | undefined) =>
  players.find((p) => p.userId === userId)?.displayName ?? userId ?? '?';

function render(c: Change<State>) {
  const { state, me, players, status, result } = c;
  if (!state) return;
  const line = winningLine(state.board);
  state.board.forEach((owner, i) => {
    const b = cells[i]!;
    const mark = owner ? (state.order.indexOf(owner) === 0 ? 'X' : 'O') : '';
    b.textContent = mark;
    b.className = (mark ? mark.toLowerCase() : '') + (line?.includes(i) ? ' win' : '');
    b.disabled = status !== 'RUNNING' || !!owner || state.turn !== me;
  });

  if (status === 'RUNNING') statusEl.textContent = state.turn === me ? 'Your turn' : `${nameOf(players, state.turn)}'s turn`;
  else statusEl.textContent = 'Game over';

  playersEl.textContent = players
    .map((p) => `${state.order.indexOf(p.userId) === 0 ? 'X' : 'O'} ${p.userId === me ? 'You' : p.displayName ?? p.userId}${p.connected ? '' : ' (offline)'}`)
    .join('  ·  ');

  if (status === 'COMPLETED' || status === 'ABANDONED') {
    const winnerId = result && !result.draw ? result.placements.find((p) => p.place === 1)?.userId : null;
    el('end-title').textContent = status === 'ABANDONED' ? 'Game ended' : result?.draw ? 'Draw' : winnerId === me ? 'You won!' : `${nameOf(players, winnerId)} won`;
    el('end-text').textContent = status === 'ABANDONED' ? `(${c.endReason ?? 'abandoned'})` : 'Thanks for playing';
    endEl.hidden = false;
  } else {
    endEl.hidden = true;
  }
  tick();
}

// Turn countdown from the server deadline, using the server-synced clock.
function tick() {
  const turn = last?.status === 'RUNNING' ? last.turn : null;
  if (!turn) { timerEl.innerHTML = '&nbsp;'; return; }
  const secs = Math.max(0, Math.ceil((turn.deadline - vibes.time.now()) / 1000));
  timerEl.textContent = `${secs} s`;
  timerEl.classList.toggle('low', secs <= 5);
}
setInterval(tick, 250);

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(code: string) {
  toastEl.textContent = MESSAGES[code] ?? code;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 1800);
}
