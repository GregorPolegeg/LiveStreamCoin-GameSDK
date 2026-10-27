// Sample game bundle (what `npx vibes-games upload` would produce with esbuild --format=iife).
// Two players, nine cells, first to three in a row. Turn timer: 30 s, then a random free cell.
(function () {
  const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  const winner = (b) => { for (const [a, c, d] of LINES) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a]; return null; };
  const place = (state, cell, playerId) => {
    state.board[cell] = playerId;
    state.turn = state.order[(state.order.indexOf(playerId) + 1) % state.order.length];
  };
  globalThis.__vibesGame = {
    minPlayers: 2,
    maxPlayers: 2,
    setup({ players, rng }) {
      const order = rng.shuffle(players.map((p) => p.userId));
      return { board: Array(9).fill(null), turn: order[0], order };
    },
    actions: {
      place(state, cell, { playerId }) {
        if (state.turn !== playerId) throw new Error('not_your_turn');
        if (!Number.isInteger(cell) || cell < 0 || cell > 8) throw new Error('bad_cell');
        if (state.board[cell]) throw new Error('taken');
        place(state, cell, playerId);
      },
    },
    turnTimer: {
      seconds: 30,
      whoseTurn: (state) => state.turn,
      onTimeout(state, playerId, { rng }) {
        const free = state.board.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
        if (free.length) place(state, rng.pick(free), playerId);
      },
    },
    gameOver(state) {
      const w = winner(state.board);
      if (w) return { placements: [{ userId: w, place: 1 }], rest: 2 };
      if (state.board.every(Boolean)) return { draw: true };
    },
  };
})();
