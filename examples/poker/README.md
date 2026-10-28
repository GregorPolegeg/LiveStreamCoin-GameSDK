# Poker

Texas Hold'em for VIBES DMs and group chats, built on the Game SDK. 1-9 people; empty seats can be bots. Play chips only, no real money.

- First a **lobby**: the host (who started the game) sets the table, everyone sees it live, then the host deals.
  - Starting chips 1,000-25,000, blinds 5/10 … 100/200, blinds go up every 5/10/15 minutes (or never), 15/30/60 s to act.
  - **When someone runs out of chips**: they're out (a real tournament), one rebuy each (until the blinds have gone up twice), or rebuy any time.
  - **Bots** for the empty seats (0-8). Playing alone, one bot always joins. Bots never see anyone's cards: they play from their own hand and the board.
- The server is the only referee: it shuffles (`ctx.rng`), deals, takes the bets, runs the turn clock and the bots, and pays the pots.
  - Real rules: blinds (heads-up: the dealer posts the small blind and acts first pre-flop), min-raise, a full raise reopens the betting, all-in for less, **side pots**, split pots (odd chips left of the dealer), the board runs out when everyone is all-in.
  - Out of time: check, or fold when there is a bet. A player who leaves folds and is out.
  - The host can end the game; chips in the middle go back.
- `view()`: you only ever get your own two cards; the others' cards are `null` until the showdown, and the deck is never sent.
- The end: places by chips left, then by who busted later. Play again (same settings) or New settings, both with the same players.
- The screen: seats on an arc around the board (from each player's own seat), casino chips for bets, the pot and every player's stack; bets slide into the pot, the pot slides to the winner. Two card styles (Soft / Geo), chosen per player. Cheap on the GPU: no blur or filters, only transform/opacity animate, and seats are updated in place (keyed), never rebuilt.
- Start options (`flags`) fill in the lobby: `chips`, `blinds` (0-4), `up` (0/5/10/15), `rebuy` `none` | `once` | `any`, `timer` (15/30/60), `bots` (0-8); `lobby: false` deals right away.

```bash
# from the SDK repo root, after npm install && npm run build
node --no-node-snapshot packages/cli/dist/index.js dev --dir examples/poker --players 3
node packages/cli/dist/index.js test --dir examples/poker
node --no-node-snapshot packages/cli/dist/index.js check --dir examples/poker
```
