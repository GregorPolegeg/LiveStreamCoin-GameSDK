# Guess the Flag

Quiz for VIBES DMs and group chats, built on the Game SDK. 1-16 players; everyone sees the same flag at the same time and picks one of four countries.

- First a **lobby**: anyone in the chat sets the game up and everyone sees it live, then anyone presses Start.
  - **Cards** (pick 1 of 4) or **Type it** (type the country, with suggestions from 2 letters; any of the 197 countries counts, so it's harder: +50 points).
  - Time per flag 5-60 s, 5-30 flags, which flags: famous / all / one continent.
- Right answer: 100 points (150 typed), up to +100 for speed, +20 per answer in a row (max +100).
- As soon as everyone has answered, the answer is shown (3.5 s): who picked what, points, streaks. Then the next flag.
- Until then, nobody sees the answer or anyone else's pick, only who has answered (`view()`).
- Wrong answers are mostly from the same continent, so it's not too easy. No flag comes up twice in one game.
- Country names in the player's own language (`Intl.DisplayNames` with the VIBES locale): Slovenian players see "Avstrija".
- Typing understands the player's language, English and common short names (USA, UK, UAE, Holland …), with or without accents.
- Start options (`flags`) fill in the lobby: `mode` `cards` | `text`, `seconds` 5-60, `rounds` 3-30, `pool` `famous` (default) | `all` | `europe` | `asia` | `africa` | `americas` | `oceania`; `lobby: false` starts right away.
- Works alone too (practice: "7 / 10 right").

```bash
# from the SDK repo root, after npm install && npm run build
node --no-node-snapshot packages/cli/dist/index.js dev --dir examples/guess-the-flag --players 4
node packages/cli/dist/index.js test --dir examples/guess-the-flag
node --no-node-snapshot packages/cli/dist/index.js check --dir examples/guess-the-flag
```

Flags: `client/flags/*.svg` from [flag-icons](https://github.com/lipis/flag-icons) 7.2.3 (MIT, see `client/flags/LICENSE-flag-icons.txt`), 197 countries (UN members + Kosovo, Palestine, Taiwan, Vatican).
