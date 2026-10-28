// Cards and hand ranking. A card is two characters: rank (23456789TJQKA) + suit (s h d c), e.g. "Ah", "Td".
export const RANKS = '23456789TJQKA';
export const SUITS = 'shdc';
export const HAND_NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'] as const;

export const fullDeck = (): string[] => { const d: string[] = []; for (const s of SUITS) for (const r of RANKS) d.push(r + s); return d; };
export const rankOf = (c: string): number => RANKS.indexOf(c[0]!) + 2;
export const isCard = (c: unknown): c is string => typeof c === 'string' && c.length === 2 && RANKS.includes(c[0]!) && SUITS.includes(c[1]!);

/** [category, ...tie-breakers]; compare with cmp(). */
export type Score = number[];

export function score5(cs: string[]): Score {
  const v = cs.map(rankOf).sort((a, b) => b - a);
  const flush = cs.every((c) => c[1] === cs[0]![1]);
  const uniq = [...new Set(v)];
  let straight = 0;
  if (uniq.length === 5) { if (v[0]! - v[4]! === 4) straight = v[0]!; else if (v.join() === '14,5,4,3,2') straight = 5; }
  const cnt = new Map<number, number>();
  for (const x of v) cnt.set(x, (cnt.get(x) ?? 0) + 1);
  const groups = [...cnt].map(([k, n]) => [n, k] as const).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const kick = groups.map((g) => g[1]);
  const [g0, g1] = [groups[0]![0], groups[1]?.[0] ?? 0];
  const cat = straight && flush ? 8 : g0 === 4 ? 7 : g0 === 3 && g1 === 2 ? 6 : flush ? 5 : straight ? 4 : g0 === 3 ? 3 : g0 === 2 && g1 === 2 ? 2 : g0 === 2 ? 1 : 0;
  const tie = straight ? [straight] : cat === 5 || cat === 0 ? v : kick;
  return [cat, ...tie];
}

export const cmp = (a: Score, b: Score): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
};

/** The best five of 5, 6 or 7 cards (every 5-card combination). */
export function best(cards: string[]): { score: Score; five: string[] } {
  let top: { score: Score; five: string[] } | null = null;
  const n = cards.length, pick: number[] = [];
  const go = (start: number) => {
    if (pick.length === 5) {
      const five = pick.map((k) => cards[k]!), score = score5(five);
      if (!top || cmp(score, top.score) > 0) top = { score, five };
      return;
    }
    for (let k = start; k <= n - (5 - pick.length); k++) { pick.push(k); go(k + 1); pick.pop(); }
  };
  go(0);
  if (!top) throw new Error('need_five_cards');
  return top;
}

export const handName = (score: Score): string => HAND_NAMES[score[0]!] ?? '';
