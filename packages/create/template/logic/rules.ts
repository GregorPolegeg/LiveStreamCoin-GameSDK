// The rules as plain functions. logic/index.ts wires them into the game.
// Keep everything the game needs in `State`: no module-level variables that change.

/** A cell holds the userId of the player who took it, or null. */
export type Cell = string | null;

export interface State {
  board: Cell[];
  /** userId of the player whose turn it is. */
  turn: string;
  /** Turn order (shuffled with ctx.rng in setup). */
  order: string[];
}

const LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

/** The userId with three in a row, or null. */
export function winner(board: readonly Cell[]): string | null {
  for (const [a, b, c] of LINES) {
    const v = board[a];
    if (v && v === board[b] && v === board[c]) return v;
  }
  return null;
}

/** The winning line (for highlighting), or null. */
export function winningLine(board: readonly Cell[]): readonly number[] | null {
  for (const line of LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return line;
  }
  return null;
}

export function freeCells(board: readonly Cell[]): number[] {
  const free: number[] = [];
  board.forEach((v, i) => { if (!v) free.push(i); });
  return free;
}

/** Payloads come from players: never trust their type. */
export function isCell(x: unknown): x is number {
  return Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 8;
}

/** Puts the player's mark on the cell and passes the turn. */
export function place(state: State, cell: number, playerId: string): void {
  state.board[cell] = playerId;
  state.turn = state.order[(state.order.indexOf(playerId) + 1) % state.order.length]!;
}
