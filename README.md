# scrabble-bot — ScrabbleBot (scrabblebot.spacetimedb.com) contender

Bot: **saketh-apex** (bot id 223, team "Saketh Apex").

## Layout

| Path | What |
|---|---|
| `engine/src/dict.ts` | Dictionary (ENABLE, same as server), anagram-class trie, formable words |
| `engine/src/netpart.ts` | Exact cost-aware "best set of disjoint words" solver (verified vs brute force) |
| `engine/src/game.ts` | Faithful simulator of the server rules (Vickrey/first-price, sim bots, last letter unusable) |
| `engine/src/bots/apex2.ts` | **Main strategy** (Lagrangian Monte-Carlo valuation, see below) |
| `engine/src/bots/apex.ts`, `basic.ts` | Older strategy, greedy/starter opponents |
| `engine/src/market.ts` | Empirical market env: competing bids sampled from real auctions |
| `engine/src/run.ts`, `sweep.ts`, `opt.ts`, `trace.ts` | Parallel runner, grid sweep, coordinate-descent tuner, single-game trace |
| `bot/` | Live SpacetimeDB client (`run.sh` keeps it alive) |
| `tools/` | SQL helper (`sql.py`), historical analysis, `live_report.py` |

## Run the live bot

```bash
/Users/sakethsripada/Development/scrabble-bot/bot/run.sh apex2 '{"K":16,"m":10,"mFrac":0.4,"playCands":3,"lambda0":0.5,"rho":0.6,"cap0":0.3,"minPlayLen":7,"brokeBal":12}'
```

The token is in `bot/.token` (gitignored). The bot joins the lobby continuously and
**auto-registers for any tournament in Registration status** (set `NO_TOURNAMENT=1` to disable).
A/B testing: set `PARAMS_B='{...}'` and it alternates by match id parity.

Live stats: `python3 tools/live_report.py <first_match_id>`.

## Strategy (Apex2)

* Score = sum of word rewards; coins only buy letters and are worthless at the end.
* Coins are a budget, relaxed with a multiplier λ (points per coin). λ falls with time and rises
  when the balance is below a planned path (budget controller).
* Rack value V(R) = average over K scenarios of the best word set from R plus m future tiles,
  each future tile costing λ × (a price sampled from real auctions of that letter at that stage of
  the match, capped at the richest opponent's balance + 1, scaled by in-match price learning).
* Bid = (V(R+L) − V(R)) / λ (Vickrey ⇒ truthful), capped by a pacing fraction of balance.
  First-price auctions are shaded.
* Plays: words of 7+ letters (3× multiplier) are cashed when score·(1+λ) + V(rest) beats holding;
  shorter words only when nearly broke; at the last auction the exact optimal partition is dumped
  (the last auctioned letter is never usable).
* Hard per-decision deadline (350 ms) so a decision never misses the 1-second auction window.
