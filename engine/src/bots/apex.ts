// Apex: Monte-Carlo marginal rack valuation with a shadow price of money.
//
// Everything is measured in points. V(R) = E_S[best partition of R u S],
// where S is a random draw of the k tiles we expect to still acquire, taken
// from the pool of tiles we have not seen. A letter's marginal worth is
// V(R+L) - V(R) (common random numbers), and we bid it divided by lambda,
// the value of one coin in points. lambda falls to 0 as the match ends,
// because leftover coins are worth nothing. Playing a word early banks cash
// now (worth lambda per coin) at the cost of rack flexibility.

import { BAG, Dict, Partitioner, VAL, greedyPartition, rackSize } from "../dict.ts";
import type { AuctionRecord, Rng, Strategy, View } from "../game.ts";

export interface ApexParams {
  K: number; // MC scenarios
  kappa: number; // expected future tiles per remaining usable auction
  kmax: number; // cap on future tiles in a scenario
  kmin: number;
  lambda0: number; // coin value at the start (points per coin)
  gamma: number; // time decay exponent of lambda
  lambdaEnd: number; // floor of lambda
  balRef: number; // balance reference for the money term
  delta: number; // balance exponent (richer -> coins worth less)
  playCands: number; // candidate words evaluated for an early play
  minPlayLen: number; // shortest word considered for an early play
  playBias: number; // extra points required to play early (>=0 keeps tiles)
  exactMax: number; // racks up to this size use the exact partition
  bidMult: number; // final multiplier on the bid
  bidAdd: number;
  priceCap: boolean; // cap bid at what can possibly be needed (opp balances)
  name?: string;
}

export const DEFAULT_APEX: ApexParams = {
  K: 32,
  kappa: 0.3,
  kmax: 7,
  kmin: 0,
  lambda0: 0.5,
  gamma: 1.0,
  lambdaEnd: 0.0,
  balRef: 100,
  delta: 0,
  playCands: 6,
  minPlayLen: 4,
  playBias: 0,
  exactMax: 13,
  bidMult: 1,
  bidAdd: 0,
  priceCap: true,
};

export class Apex implements Strategy {
  name: string;
  d: Dict;
  p: ApexParams;
  part: Partitioner;
  cache = new Map<string, number>();
  seat = 0;
  rng!: Rng;
  myStart = new Uint8Array(26);
  myWon = new Uint8Array(26);
  started = false;
  // diagnostics
  lastLambda = 0;

  constructor(d: Dict, p: Partial<ApexParams> = {}, part?: Partitioner) {
    this.d = d;
    this.p = { ...DEFAULT_APEX, ...p };
    this.name = this.p.name ?? "Apex";
    this.part = part ?? new Partitioner(d);
  }

  reset(seat: number, _n: number, rng: Rng) {
    this.seat = seat;
    this.rng = rng;
    this.myStart.fill(0);
    this.myWon.fill(0);
    this.started = false;
    if (this.cache.size > 400_000) this.cache.clear();
  }

  // Random number source independent from the game RNG (so our sampling does
  // not perturb the game's draw sequence).
  private s = 12345;
  private rnd(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  evalRack(r: Uint8Array): number {
    const k = String.fromCharCode.apply(null, r as unknown as number[]);
    const c = this.cache.get(k);
    if (c !== undefined) return c;
    const n = rackSize(r);
    const v = n <= this.p.exactMax ? this.part.best(r) : greedyPartition(this.d, r, 3, 2);
    this.cache.set(k, v);
    return v;
  }

  // Tiles not seen by us: BAG - our tiles - letters others won or that went
  // unsold - opponents' starting tiles revealed through their words.
  unseen(v: View): Int32Array {
    const pool = Int32Array.from(BAG);
    for (let c = 0; c < 26; c++) pool[c]! -= this.myStart[c]! + this.myWon[c]!;
    const oppWon: Int32Array[] = [];
    for (let i = 0; i < v.nPlayers; i++) oppWon.push(new Int32Array(26));
    for (const a of v.auctions) {
      if (a.winner === this.seat) continue;
      pool[a.letter]!--;
      if (a.winner >= 0) oppWon[a.winner]![a.letter]!++;
    }
    const played: Int32Array[] = [];
    for (let i = 0; i < v.nPlayers; i++) played.push(new Int32Array(26));
    for (const w of v.words) {
      if (w.seat === this.seat) continue;
      for (let i = 0; i < w.word.length; i++) played[w.seat]![w.word.charCodeAt(i) - 65]!++;
    }
    for (let i = 0; i < v.nPlayers; i++) {
      if (i === this.seat) continue;
      for (let c = 0; c < 26; c++) {
        const rev = played[i]![c]! - oppWon[i]![c]!;
        if (rev > 0) pool[c]! -= rev;
      }
    }
    for (let c = 0; c < 26; c++) if (pool[c]! < 0) pool[c] = 0;
    return pool;
  }

  sampleScenarios(pool: Int32Array, k: number, K: number): Uint8Array[] {
    const flat: number[] = [];
    for (let c = 0; c < 26; c++) for (let i = 0; i < pool[c]!; i++) flat.push(c);
    const out: Uint8Array[] = [];
    k = Math.min(k, flat.length);
    for (let j = 0; j < K; j++) {
      const s = new Uint8Array(26);
      // partial Fisher-Yates
      for (let i = 0; i < k; i++) {
        const idx = i + Math.floor(this.rnd() * (flat.length - i));
        const t = flat[i]!;
        flat[i] = flat[idx]!;
        flat[idx] = t;
        s[flat[i]!]!++;
      }
      out.push(s);
    }
    return out;
  }

  V(r: Uint8Array, scen: Uint8Array[]): number {
    if (scen.length === 0) return this.evalRack(r);
    const tmp = new Uint8Array(26);
    let tot = 0;
    for (const s of scen) {
      for (let c = 0; c < 26; c++) tmp[c] = r[c]! + s[c]!;
      tot += this.evalRack(tmp);
    }
    return tot / scen.length;
  }

  lambda(v: View, balance: number): number {
    const p = this.p;
    const frac = Math.max(0, v.bagLeft - 1) / v.totalAuctions;
    const money = Math.pow(p.balRef / Math.max(10, balance + 10), p.delta);
    return Math.max(p.lambdaEnd, p.lambda0 * Math.pow(frac, p.gamma) * money);
  }

  act(v: View): { words: string[]; bid: number } {
    const d = this.d;
    const p = this.p;
    if (!this.started) {
      this.myStart.set(v.rack);
      this.started = true;
    }
    const r = Uint8Array.from(v.rack);
    const words: string[] = [];
    let balance = v.balance;

    // Last auction: its letter can never be used. Dump everything optimally.
    if (v.bagLeft === 0) {
      for (const c of this.part.plan(r)) {
        words.push(d.classWord[c]!);
        for (let k = 0; k < 26; k++) r[k]! -= d.classCounts[c * 26 + k]!;
      }
      return { words, bid: 0 };
    }

    const usableFuture = Math.max(0, v.bagLeft - 1);
    const k = Math.max(
      Math.min(p.kmin, usableFuture),
      Math.min(usableFuture, p.kmax, Math.round(p.kappa * usableFuture)),
    );
    const pool = this.unseen(v);
    pool[v.letter] = Math.max(0, pool[v.letter]! - 1);
    const scen = k > 0 ? this.sampleScenarios(pool, k, p.K) : [];

    // ---- Early word plays ----
    for (let guard = 0; guard < 4; guard++) {
      const lam = this.lambda(v, balance);
      const cs = d.formable(r, p.minPlayLen);
      if (cs.length === 0) break;
      cs.sort((a, b) => d.classScore[b]! - d.classScore[a]!);
      const keep = this.V(r, scen);
      let bestVal = keep + p.playBias;
      let bestCls = -1;
      const n = Math.min(cs.length, p.playCands);
      for (let i = 0; i < n; i++) {
        const w = cs[i]!;
        const o = w * 26;
        for (let c = 0; c < 26; c++) r[c]! -= d.classCounts[o + c]!;
        const val = d.classScore[w]! * (1 + lam) + this.V(r, scen);
        for (let c = 0; c < 26; c++) r[c]! += d.classCounts[o + c]!;
        if (val > bestVal) {
          bestVal = val;
          bestCls = w;
        }
      }
      if (bestCls < 0) break;
      words.push(d.classWord[bestCls]!);
      balance += d.classScore[bestCls]!;
      for (let c = 0; c < 26; c++) r[c]! -= d.classCounts[bestCls * 26 + c]!;
    }

    // ---- Bid ----
    // The letter of the second-to-last auction is still usable (during the
    // last auction's window); anything later is not.
    const lam = this.lambda(v, balance);
    this.lastLambda = lam;
    const base = this.V(r, scen);
    r[v.letter]!++;
    const withL = this.V(r, scen);
    r[v.letter]!--;
    const delta = withL - base;
    let bid = delta <= 0 ? 0 : (lam > 1e-6 ? delta / lam : balance) * p.bidMult + p.bidAdd;
    if (delta <= 0) bid = 0;
    if (p.priceCap) {
      // Never need to bid more than 1 above every opponent's balance.
      let maxOpp = 0;
      for (let i = 0; i < v.nPlayers; i++)
        if (i !== this.seat) maxOpp = Math.max(maxOpp, v.balances[i]!);
      bid = Math.min(bid, maxOpp + 1);
    }
    bid = Math.max(0, Math.min(balance, Math.floor(bid)));
    return { words, bid };
  }

  onResult(_v: View, rec: AuctionRecord) {
    if (rec.winner === this.seat) this.myWon[rec.letter]!++;
  }
}
