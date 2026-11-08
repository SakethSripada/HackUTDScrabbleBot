// Baseline / opponent strategies used to populate simulated matches.
import { Dict, Partitioner, VAL } from "../dict.ts";
import type { Strategy, View } from "../game.ts";

// The repo's bot-starter: face+2 for new letters, play longest word ASAP.
export class StarterBot implements Strategy {
  name = "Starter";
  d: Dict;
  constructor(d: Dict) {
    this.d = d;
  }
  act(v: View) {
    const words: string[] = [];
    const r = Uint8Array.from(v.rack);
    // longest word
    const cs = this.d.formable(r, 2);
    let best = -1;
    for (const c of cs) if (best < 0 || this.d.classLen[c]! > this.d.classLen[best]!) best = c;
    if (best >= 0) {
      words.push(this.d.classWord[best]!);
      for (let c = 0; c < 26; c++) r[c]! -= this.d.classCounts[best * 26 + c]!;
    }
    const value = VAL[v.letter]!;
    const have = r[v.letter]!;
    const want = have === 0 ? value + 2 : Math.max(1, value);
    return { words, bid: Math.min(want, v.balance) };
  }
}

export interface GreedyParams {
  a: number; // intercept
  b: number; // per face point
  synergy: number; // extra if the letter lengthens the best word
  maxFrac: number; // max fraction of balance per bid
  minPlayLen: number; // play a word once it reaches this length
  endDump: boolean; // dump the best partition at the last chance
  noise: number; // +-uniform noise on bid
  name?: string;
}

// A tunable "competent" bot resembling the stronger real entrants: bid on
// face value with synergy, hoard for long words, dump at the end.
export class GreedyBot implements Strategy {
  name: string;
  d: Dict;
  p: GreedyParams;
  part: Partitioner;
  rngv = 0;
  constructor(d: Dict, p: GreedyParams, part?: Partitioner) {
    this.d = d;
    this.p = p;
    this.name = p.name ?? "Greedy";
    this.part = part ?? new Partitioner(d);
  }
  private bestLen(r: Uint8Array): number {
    let m = 0;
    for (const c of this.d.formable(r, 2)) if (this.d.classLen[c]! > m) m = this.d.classLen[c]!;
    return m;
  }
  act(v: View) {
    const d = this.d;
    const words: string[] = [];
    const r = Uint8Array.from(v.rack);
    const last = v.bagLeft === 0;
    if (last && this.p.endDump) {
      for (const c of this.part.plan(r)) {
        words.push(d.classWord[c]!);
        for (let k = 0; k < 26; k++) r[k]! -= d.classCounts[c * 26 + k]!;
      }
      return { words, bid: 0 };
    }
    // Play the best long word(s) when available.
    for (;;) {
      let best = -1;
      for (const c of d.formable(r, this.p.minPlayLen))
        if (best < 0 || d.classScore[c]! > d.classScore[best]!) best = c;
      if (best < 0) break;
      words.push(d.classWord[best]!);
      for (let k = 0; k < 26; k++) r[k]! -= d.classCounts[best * 26 + k]!;
    }
    if (last) return { words, bid: 0 };
    let bid = this.p.a + this.p.b * VAL[v.letter]!;
    const before = this.bestLen(r);
    r[v.letter]!++;
    const after = this.bestLen(r);
    r[v.letter]!--;
    if (after > before && after >= 4) bid += this.p.synergy;
    bid += (Math.random() * 2 - 1) * this.p.noise;
    let bal = v.balance;
    for (const w of words) bal += wordScoreOf(w);
    bid = Math.min(bid, this.p.maxFrac * bal);
    return { words, bid: Math.max(0, Math.round(bid)) };
  }
}

function wordScoreOf(w: string): number {
  let b = 0;
  for (let i = 0; i < w.length; i++) b += VAL[w.charCodeAt(i) - 65]!;
  const n = w.length;
  if (n <= 3) return b;
  if (n === 4) return Math.floor((b * 3) / 2);
  if (n === 5) return b * 2;
  if (n === 6) return Math.floor((b * 5) / 2);
  return b * 3;
}
