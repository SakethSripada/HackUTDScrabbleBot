// Faithful simulator of the ScrabbleBot match rules (spacetimedb/src/game.ts):
//  - 98-tile bag, no blanks; each seat dealt 5 tiles in seat order.
//  - One letter per auction; sealed bids <= balance; bids of 0 ignored.
//  - Vickrey: winner pays 2nd-highest bid, or min(1, bid) if alone.
//    First-price supported too. Ties broken uniformly at random.
//  - Sim bots play their longest >=3-letter word right after winning.
//  - The match ends the moment the auction that empties the bag closes, so
//    the very last letter can never be played.
//  - Words: any dictionary word >= 2 letters; reward = face x length mult,
//    added to both balance and score.

import { BAG, Dict, VAL, lengthScore } from "./dict.ts";

export class Rng {
  s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    // mulberry32
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    // inclusive
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
}

export interface AuctionRecord {
  round: number;
  letter: number;
  winner: number; // seat or -1
  paid: number;
  topBid: number;
}

export interface WordRecord {
  round: number; // auction index during which it was played
  seat: number;
  word: string;
  score: number;
}

export interface PlayerState {
  rack: Uint8Array;
  balance: number;
  score: number;
  everHeld: Uint8Array; // all tiles ever held (starting + won)
}

// What a strategy may see. Mirrors what is public on the real server, plus
// its own private rack.
export interface View {
  seat: number;
  nPlayers: number;
  round: number; // index of the current auction, 0-based
  totalAuctions: number; // 98 - 5*n
  bagLeft: number; // tiles left in bag after drawing the current letter
  letter: number; // letter being auctioned (-1 for none)
  rack: Uint8Array; // my rack (do not mutate)
  balance: number;
  score: number;
  balances: number[];
  scores: number[];
  auctions: AuctionRecord[];
  words: WordRecord[];
  startingRack: number;
  auctionType: "Vickrey" | "FirstPrice";
}

export interface Strategy {
  name: string;
  // Called once per match.
  reset?(seat: number, nPlayers: number, rng: Rng): void;
  // Called when an auction opens. Return words to play now (in order) and the
  // bid. Words are validated; invalid ones are skipped.
  act(v: View): { words: string[]; bid: number };
  // Notified after each auction closes.
  onResult?(v: View, rec: AuctionRecord): void;
  isSim?: boolean;
}

export interface MatchResult {
  scores: number[];
  balances: number[];
  names: string[];
  auctions: AuctionRecord[];
  words: WordRecord[];
  leftover: number[]; // tiles left in rack at end
}

export class Game {
  d: Dict;
  rng: Rng;
  bag: number[];
  bagTotal: number;
  players: PlayerState[];
  strategies: Strategy[];
  auctions: AuctionRecord[] = [];
  words: WordRecord[] = [];
  auctionType: "Vickrey" | "FirstPrice";
  startingRack: number;
  totalAuctions: number;

  constructor(
    d: Dict,
    strategies: Strategy[],
    seed: number,
    opts: { auctionType?: "Vickrey" | "FirstPrice"; startingRack?: number } = {},
  ) {
    this.d = d;
    this.rng = new Rng(seed);
    this.strategies = strategies;
    this.auctionType = opts.auctionType ?? "Vickrey";
    this.startingRack = opts.startingRack ?? 5;
    this.bag = BAG.slice();
    this.bagTotal = 98;
    this.players = strategies.map(() => ({
      rack: new Uint8Array(26),
      balance: 100,
      score: 0,
      everHeld: new Uint8Array(26),
    }));
    this.totalAuctions = 98 - this.startingRack * strategies.length;
  }

  draw(): number {
    if (this.bagTotal === 0) return -1;
    let idx = this.rng.int(0, this.bagTotal - 1);
    for (let c = 0; c < 26; c++) {
      const n = this.bag[c]!;
      if (n === 0) continue;
      if (idx < n) {
        this.bag[c]!--;
        this.bagTotal--;
        return c;
      }
      idx -= n;
    }
    return -1;
  }

  view(seat: number, round: number, letter: number): View {
    const p = this.players[seat]!;
    return {
      seat,
      nPlayers: this.players.length,
      round,
      totalAuctions: this.totalAuctions,
      bagLeft: this.bagTotal,
      letter,
      rack: p.rack,
      balance: p.balance,
      score: p.score,
      balances: this.players.map((q) => q.balance),
      scores: this.players.map((q) => q.score),
      auctions: this.auctions,
      words: this.words,
      startingRack: this.startingRack,
      auctionType: this.auctionType,
    };
  }

  playWord(seat: number, word: string, round: number): boolean {
    const w = word.toUpperCase();
    if (w.length < 2 || !this.d.isWord(w)) return false;
    const p = this.players[seat]!;
    const need = new Uint8Array(26);
    let base = 0;
    for (let i = 0; i < w.length; i++) {
      const c = w.charCodeAt(i) - 65;
      need[c]!++;
      base += VAL[c]!;
    }
    for (let c = 0; c < 26; c++) if (need[c]! > p.rack[c]!) return false;
    for (let c = 0; c < 26; c++) p.rack[c]! -= need[c]!;
    const s = lengthScore(base, w.length);
    p.balance += s;
    p.score += s;
    this.words.push({ round, seat, word: w, score: s });
    return true;
  }

  run(): MatchResult {
    const n = this.players.length;
    for (let i = 0; i < n; i++) this.strategies[i]!.reset?.(i, n, this.rng);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < this.startingRack; k++) {
        const c = this.draw();
        if (c < 0) break;
        this.players[i]!.rack[c]!++;
        this.players[i]!.everHeld[c]!++;
      }
    }
    let letter = this.draw();
    let round = 0;
    const bids = new Array<number>(n).fill(0);
    while (letter >= 0) {
      // Each strategy plays words (async in reality) and bids.
      for (let i = 0; i < n; i++) {
        const s = this.strategies[i]!;
        const act = s.act(this.view(i, round, letter));
        for (const w of act.words) this.playWord(i, w, round);
        let b = Math.floor(act.bid);
        const bal = this.players[i]!.balance;
        if (!(b > 0)) b = 0;
        if (b > bal) b = bal; // server rejects > balance; we clamp
        bids[i] = b;
      }
      // Resolve: shuffle then stable sort desc.
      const order: number[] = [];
      for (let i = 0; i < n; i++) if (bids[i]! > 0) order.push(i);
      for (let i = order.length - 1; i >= 1; i--) {
        const j = this.rng.int(0, i);
        const t = order[i]!;
        order[i] = order[j]!;
        order[j] = t;
      }
      order.sort((a, b) => bids[b]! - bids[a]!);
      let winner = -1;
      let paid = 0;
      let top = 0;
      if (order.length > 0) {
        winner = order[0]!;
        top = bids[winner]!;
        if (this.auctionType === "FirstPrice") paid = top;
        else paid = order.length > 1 ? bids[order[1]!]! : Math.min(1, top);
        const p = this.players[winner]!;
        if (p.balance >= paid) {
          p.balance -= paid;
          p.rack[letter]!++;
          p.everHeld[letter]!++;
        } else {
          winner = -1;
        }
      }
      const rec: AuctionRecord = { round, letter, winner, paid, topBid: top };
      this.auctions.push(rec);
      if (winner >= 0 && this.strategies[winner]!.isSim) {
        // Server: simulateWordPlay right after the win.
        const w = simBestPlayable(this.d, this.players[winner]!.rack, 3);
        if (w) this.playWord(winner, w, round);
      }
      for (let i = 0; i < n; i++)
        this.strategies[i]!.onResult?.(this.view(i, round, letter), rec);
      letter = this.draw();
      round++;
    }
    return {
      scores: this.players.map((p) => p.score),
      balances: this.players.map((p) => p.balance),
      names: this.strategies.map((s) => s.name),
      auctions: this.auctions,
      words: this.words,
      leftover: this.players.map((p) => p.rack.reduce((a, b) => a + b, 0)),
    };
  }
}

// Server's findBestPlayable: longest word >= minLen, ties -> lexicographically
// smallest word. We emulate via classes: longest length, then smallest
// representative among all words of that class... the server iterates words
// (not classes) sorted by length desc then lex; the first spellable word wins.
let SIM_WORDS_BY_LEN: string[] | undefined;
export function simBestPlayable(d: Dict, rack: Uint8Array, minLen: number): string | undefined {
  let total = 0;
  for (let c = 0; c < 26; c++) total += rack[c]!;
  if (total < minLen) return undefined;
  // Fast path: find longest formable length via classes, then the lexicographically
  // smallest word among formable classes of that length.
  const cls = d.formable(rack, minLen);
  if (cls.length === 0) return undefined;
  let maxLen = 0;
  for (const c of cls) if (d.classLen[c]! > maxLen) maxLen = d.classLen[c]!;
  SIM_WORDS_BY_LEN ??= [];
  let best: string | undefined;
  for (const c of cls) {
    if (d.classLen[c]! !== maxLen) continue;
    // smallest word in this anagram class
    const w = smallestAnagram(d, c);
    if (best === undefined || w < best) best = w;
  }
  return best;
}

let SMALLEST: Map<number, string> | undefined;
function smallestAnagram(d: Dict, cls: number): string {
  if (!SMALLEST) {
    SMALLEST = new Map();
    const keyToCls = new Map<string, number>();
    for (let i = 0; i < d.nClasses; i++) {
      const k = d.classWord[i]!.split("").sort().join("");
      keyToCls.set(k, i);
    }
    for (const w of d.words) {
      const k = w.split("").sort().join("");
      const ci = keyToCls.get(k)!;
      const cur = SMALLEST.get(ci);
      if (cur === undefined || w < cur) SMALLEST.set(ci, w);
    }
  }
  return SMALLEST.get(cls)!;
}

// ---------- Server sim bots ----------

export type SimKind = "Cheapskate" | "ValueBidder" | "Aggressive";

export class SimBot implements Strategy {
  name: string;
  kind: SimKind;
  isSim = true;
  rng!: Rng;
  constructor(kind: SimKind, name?: string) {
    this.kind = kind;
    this.name = name ?? `${kind}-sim`;
  }
  reset(_seat: number, _n: number, rng: Rng) {
    this.rng = rng;
  }
  act(v: View) {
    const value = VAL[v.letter]!;
    const isVowel = [0, 4, 8, 14, 20].includes(v.letter);
    let base: number;
    if (this.kind === "Cheapskate") base = value - 1;
    else if (this.kind === "ValueBidder") base = value;
    else base = value + (isVowel ? 4 : 2);
    const jitter = this.rng.int(-2, 2);
    const b = Math.max(Math.min(Math.max(base + jitter, 1), v.balance), 0);
    return { words: [], bid: b };
  }
}
