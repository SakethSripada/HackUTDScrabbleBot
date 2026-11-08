// Empirical market environment: our bot in seat 0 against 5 "phantom"
// opponents whose highest bid each auction is sampled from real auctions on
// the live server (same letter, same quarter of the match). With prob 5/6 we
// replaced a non-top bidder, so the competing max is that auction's top bid;
// otherwise it's the runner-up (the price paid).

import * as fs from "node:fs";
import * as path from "node:path";
import type { Strategy } from "./game.ts";
import { Game, Rng } from "./game.ts";

type Market = Record<string, number[][][]>; // letter -> phase -> [top, paid][]
let MARKET: Market | undefined;
export function market(): Market {
  MARKET ??= JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), "..", "market.json"),
      "utf8",
    ),
  );
  return MARKET!;
}

export class Phantom implements Strategy {
  name = "Market";
  rng!: Rng;
  scale: number;
  constructor(scale = 1) {
    this.scale = scale;
  }
  reset(_s: number, _n: number, rng: Rng) {
    this.rng = rng;
  }
  // Only seat 1 actually bids the sampled competing max; the others pass.
  act() {
    return { words: [], bid: 0 };
  }
}

// A game where seats 1..5 are phantoms. We implement by subclassing the
// bidding: seat 1 bids the sampled market max, seats 2..5 never bid.
export class MarketPhantom implements Strategy {
  name = "Market";
  rng!: Rng;
  scale: number;
  constructor(scale = 1) {
    this.scale = scale;
  }
  reset(_s: number, _n: number, rng: Rng) {
    this.rng = rng;
  }
  act(v: { letter: number; round: number; totalAuctions: number }) {
    const L = String.fromCharCode(65 + v.letter);
    const NPH = market()[L]!.length;
    const ph = Math.min(NPH - 1, Math.floor((v.round * NPH) / v.totalAuctions));
    const arr = market()[L]![ph]!;
    const pick = arr[Math.floor(this.rng.next() * arr.length)]!;
    const useTop = this.rng.next() < 5 / 6;
    const bid = Math.round((useTop ? pick[0]! : pick[1]!) * this.scale);
    return { words: [], bid };
  }
}

export class Idle implements Strategy {
  name = "Idle";
  act() {
    return { words: [], bid: 0 };
  }
}

export function marketLineup(me: Strategy, scale = 1): Strategy[] {
  return [me, new MarketPhantom(scale), new Idle(), new Idle(), new Idle(), new Idle()];
}

// Give phantoms an effectively unlimited budget.
export function marketGame(d: ConstructorParameters<typeof Game>[0], me: Strategy, seed: number, scale = 1): Game {
  const g = new Game(d, marketLineup(me, scale), seed);
  for (let i = 1; i < 6; i++) g.players[i]!.balance = 100000;
  return g;
}

let HIST: number[][] | undefined;
export function histScores(): number[][] {
  HIST ??= JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), "..", "hist_scores.json"),
      "utf8",
    ),
  );
  return HIST!;
}

// Estimated probability that `score` wins a random historical table (we
// replace one random seat) and expected rank (0 = first).
export function winVsHistory(score: number): { win: number; rank: number } {
  const H = histScores();
  let win = 0;
  let rank = 0;
  let n = 0;
  for (const s of H) {
    if (s.length < 6) continue;
    for (let drop = 0; drop < s.length; drop++) {
      let better = 0;
      let ties = 0;
      for (let i = 0; i < s.length; i++) {
        if (i === drop) continue;
        if (s[i]! > score) better++;
        else if (s[i]! === score) ties++;
      }
      if (better === 0) win += 1 / (1 + ties);
      rank += better;
      n++;
    }
  }
  return { win: win / n, rank: rank / n };
}
