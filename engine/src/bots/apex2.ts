// Apex2: Lagrangian rack valuation.
//
// Points are the objective; coins are a budget. We relax the budget with a
// multiplier lambda (points per coin). The value of a rack R is
//   V(R) = E_S[ max over word sets W from R u S of  score(W) - lambda * price(S-tiles used) ]
// where S is a sample of tiles that will come up for auction later, each
// tagged with a sampled clearing price (the highest competing bid). So the
// valuation decides which future tiles are worth buying at market prices.
// A letter on auction now is worth  (V(R+L) - V(R)) / lambda  coins, which
// we bid (Vickrey: truthful bidding is right per auction). Playing a word
// now banks score + lambda * score (coins now can be re-spent).

import { BAG, Dict, VAL } from "../dict.ts";
import { NetPartition } from "../netpart.ts";
import type { AuctionRecord, Rng, Strategy, View } from "../game.ts";
import { market } from "../market.ts";

export interface Apex2Params {
  K: number; // scenarios
  m: number; // future tiles per scenario (cap)
  mFrac: number; // fraction of usable future auctions sampled
  minLen: number; // min word length in mid-game valuation
  lambda0: number;
  gamma: number;
  delta: number;
  balRef: number;
  lambdaMin: number;
  priceScale: number; // multiply sampled prices
  priceAdd: number;
  learnPrices: number; // weight on in-match observed prices (0 = off)
  learnPrior: number; // pseudo-observations at ratio 1
  loseScale: number; // inflate lower-bound observations from lost auctions
  playCands: number;
  playBias: number;
  bidMult: number;
  bidAdd: number;
  oppCap: boolean;
  shade: number; // first-price shading factor (1 = none)
  rho: number; // planned balance path: planBal * frac^rho
  playInBid: boolean;
  fpShade: number; // bid multiplier in first-price auctions
  hvBidMult: number; // extra multiplier on bids for J/K/Q/X/Z
  floorFrac: number; // if a letter has positive value, bid at least this x its expected price
  hvFloor: number; // scale of per-letter floor bids for J/K/Q/X/Z (0 = off)
  hvMinUsable: number; // only while this many usable auctions remain
  hvCap: number; // pacing cap fraction for J/K/Q/X/Z
  maxTotal: number; // cap rack + future tiles in a scenario
  timeBudget: number; // ms per decision before K is reduced
  qcap: number; // cap bids at this quantile of the letter's market price (>=1 disables)
  qcapMult: number;
  minPlayLen: number; // early plays shorter than this need balance below brokeBal
  brokeBal: number;
  planBal: number;
  lambdaMax: number;
  cap0: number; // max fraction of balance on one bid at the start
  capPow: number; // cap rises to 1 as (1-frac)^capPow
  name?: string;
}

export const DEFAULT_APEX2: Apex2Params = {
  K: 10,
  m: 6,
  mFrac: 0.35,
  minLen: 4,
  lambda0: 0.35,
  gamma: 0.6,
  delta: 1,
  balRef: 15,
  lambdaMin: 0.02,
  priceScale: 1,
  priceAdd: 0,
  learnPrices: 1,
  learnPrior: 6,
  loseScale: 1.25,
  playCands: 4,
  playBias: 0,
  bidMult: 1,
  bidAdd: 0,
  oppCap: true,
  shade: 1,
  rho: 1,
  playInBid: true,
  fpShade: 0.7,
  hvBidMult: 1,
  floorFrac: 0,
  hvFloor: 0,
  hvMinUsable: 15,
  hvCap: 0.3,
  maxTotal: 18,
  timeBudget: 350,
  qcap: 1,
  qcapMult: 1,
  minPlayLen: 2,
  brokeBal: 0,
  planBal: 100,
  lambdaMax: 5,
  cap0: 0.35,
  capPow: 2,
};

// Precomputed market price samples (highest competing bid) per letter/phase.
let PRICE: number[][][] | undefined;
function priceTable(): number[][][] {
  if (PRICE) return PRICE;
  const mk = market();
  PRICE = [];
  for (let c = 0; c < 26; c++) {
    const L = String.fromCharCode(65 + c);
    const phases: number[][] = [];
    for (let ph = 0; ph < mk[L]!.length; ph++) {
      const arr = mk[L]![ph]!;
      // mixture: top bid w.p. 5/6, runner-up w.p. 1/6 -> expand
      const out: number[] = [];
      for (const [t, p] of arr) {
        for (let i = 0; i < 5; i++) out.push(t!);
        out.push(p!);
      }
      phases.push(out);
    }
    PRICE.push(phases);
  }
  return PRICE;
}

export class Apex2 implements Strategy {
  name: string;
  d: Dict;
  p: Apex2Params;
  np: NetPartition;
  seat = 0;
  myStart = new Uint8Array(26);
  myWon = new Uint8Array(26);
  started = false;
  // in-match price learning: observed paid per letter
  obsSum = new Float64Array(26);
  obsN = new Float64Array(26);
  obsAll = 0;
  obsAllN = 0;
  private s = 987654321;
  lastLam = 0;
  pf = 1;
  kEff = 0;
  deadline = Infinity;
  scenLimit = Infinity;
  myBids = new Map<number, number>();
  meanCache = new Map<number, number>();
  qCache = new Map<number, number>();

  constructor(d: Dict, p: Partial<Apex2Params> = {}, np?: NetPartition) {
    this.d = d;
    this.p = { ...DEFAULT_APEX2, ...p };
    this.name = this.p.name ?? "Apex2";
    this.np = np ?? new NetPartition(d);
  }

  reset(seat: number, _n: number, rng: Rng) {
    this.seat = seat;
    this.myStart.fill(0);
    this.myWon.fill(0);
    this.started = false;
    this.obsSum.fill(0);
    this.obsN.fill(0);
    this.obsAll = 0;
    this.obsAllN = 0;
    this.s = (rng.next() * 4294967296) >>> 0;
    this.myBids.clear();
    this.kEff = this.p.K;
  }

  private rnd(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  unseen(v: View): Int32Array {
    const pool = Int32Array.from(BAG);
    for (let c = 0; c < 26; c++) pool[c]! -= this.myStart[c]! + this.myWon[c]!;
    const oppWon: Int32Array[] = [];
    const played: Int32Array[] = [];
    for (let i = 0; i < v.nPlayers; i++) {
      oppWon.push(new Int32Array(26));
      played.push(new Int32Array(26));
    }
    for (const a of v.auctions) {
      if (a.winner === this.seat) continue;
      pool[a.letter]!--;
      if (a.winner >= 0) oppWon[a.winner]![a.letter]!++;
    }
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

  samplePrice(c: number, round: number, total: number, cap: number): number {
    const T = priceTable();
    const ph = Math.min(T[c]!.length - 1, Math.floor((round * T[c]!.length) / total));
    const arr = T[c]![ph]!;
    let pr = arr[Math.floor(this.rnd() * arr.length)]!;
    pr *= this.pf;
    pr = pr * this.p.priceScale + this.p.priceAdd;
    return Math.max(1, Math.min(pr, cap));
  }

  // Scenario = per-letter list of prices of tiles we could buy later.
  scenarios(v: View, pool: Int32Array, usable: number, cap: number): number[][][] {
    const p = this.p;
    let rs = 0;
    for (let c = 0; c < 26; c++) rs += v.rack[c]!;
    const m = Math.min(p.m, usable, Math.max(0, Math.round(p.mFrac * usable)), Math.max(3, p.maxTotal - rs));
    const flat: number[] = [];
    for (let c = 0; c < 26; c++) for (let i = 0; i < pool[c]!; i++) flat.push(c);
    const out: number[][][] = [];
    if (m <= 0 || flat.length === 0) return out;
    for (let j = 0; j < this.kEff; j++) {
      const ex: number[][] = [];
      for (let c = 0; c < 26; c++) ex.push([]);
      for (let i = 0; i < m && i < flat.length; i++) {
        const idx = i + Math.floor(this.rnd() * (flat.length - i));
        const t = flat[i]!;
        flat[i] = flat[idx]!;
        flat[idx] = t;
        const c = flat[i]!;
        // the tile appears at a random future round
        const fr = v.round + 1 + Math.floor(this.rnd() * usable);
        ex[c]!.push(this.samplePrice(c, fr, v.totalAuctions, cap));
      }
      out.push(ex);
    }
    return out;
  }

  V(r: Uint8Array, scen: number[][][], lam: number): number {
    if (scen.length === 0) return this.np.solve(r, null, false, 2).value;
    let tot = 0;
    let cnt = 0;
    const ex: number[][] = [];
    for (let c = 0; c < 26; c++) ex.push([]);
    const lim = Math.min(scen.length, this.scenLimit);
    for (let j = 0; j < lim; j++) {
      if (j >= 1 && performance.now() > this.deadline) {
        this.scenLimit = j;
        break;
      }
      const s = scen[j]!;
      cnt++;
      for (let c = 0; c < 26; c++) {
        const src = s[c]!;
        const dst = ex[c]!;
        dst.length = src.length;
        for (let i = 0; i < src.length; i++) dst[i] = src[i]! * lam;
      }
      tot += this.np.solve(r, ex, false, this.p.minLen).value;
    }
    return tot / Math.max(1, cnt);
  }

  // Shadow price of a coin. Falls with time (coins are worthless at the
  // end) and rises when we are poorer than our planned spending path.
  // Value of holding rack r, including the option to cash a word right away
  // (worth score * (1 + lambda) because coins now can be re-spent).
  bestValue(r: Uint8Array, scen: number[][][], lam: number, balance: number): number {
    const d = this.d;
    const p = this.p;
    let best = this.V(r, scen, lam);
    if (!p.playInBid) return best;
    const cs = d.formable(r, balance < p.brokeBal ? 2 : p.minPlayLen);
    if (cs.length === 0) return best;
    cs.sort((a, b) => d.classScore[b]! - d.classScore[a]!);
    const n = Math.min(cs.length, p.playCands);
    for (let i = 0; i < n; i++) {
      const w = cs[i]!;
      const o = w * 26;
      for (let c = 0; c < 26; c++) r[c]! -= d.classCounts[o + c]!;
      const val = d.classScore[w]! * (1 + lam) + p.playBias * 0 + this.V(r, scen, lam);
      for (let c = 0; c < 26; c++) r[c]! += d.classCounts[o + c]!;
      if (val > best) best = val;
    }
    return best;
  }

  lambda(v: View, balance: number): number {
    const p = this.p;
    const frac = Math.max(0, v.bagLeft - 1) / v.totalAuctions;
    const planned = p.planBal * Math.pow(frac, p.rho);
    const money = Math.pow((planned + p.balRef) / (Math.max(0, balance) + p.balRef), p.delta);
    const lam = p.lambda0 * Math.pow(frac, p.gamma) * money;
    return Math.min(p.lambdaMax, Math.max(p.lambdaMin, lam));
  }

  act(v: View): { words: string[]; bid: number } {
    const t0 = performance.now();
    if (this.kEff <= 0) this.kEff = this.p.K;
    this.deadline = t0 + this.p.timeBudget;
    this.scenLimit = Infinity;
    const out = this.act0(v);
    const dt = performance.now() - t0;
    // Keep decisions inside the 1-second auction window.
    if (dt > this.p.timeBudget) this.kEff = Math.max(2, Math.floor(this.kEff * 0.6));
    else if (dt < this.p.timeBudget / 4 && this.kEff < this.p.K) this.kEff++;
    return out;
  }

  act0(v: View): { words: string[]; bid: number } {
    const d = this.d;
    const p = this.p;
    if (!this.started) {
      this.myStart.set(v.rack);
      this.started = true;
    }
    const r = Uint8Array.from(v.rack);
    const words: string[] = [];
    let balance = v.balance;

    if (v.bagLeft === 0) {
      const sol = this.np.solve(r, null, true, 2);
      for (const c of sol.plan) words.push(d.classWord[c]!);
      return { words, bid: 0 };
    }

    const usable = Math.max(0, v.bagLeft - 1);
    let maxOpp = 0;
    for (let i = 0; i < v.nPlayers; i++) if (i !== this.seat) maxOpp = Math.max(maxOpp, v.balances[i]!);
    const pool = this.unseen(v);
    pool[v.letter] = Math.max(0, pool[v.letter]! - 1);
    this.pf = this.priceFactor();
    const scen = this.scenarios(v, pool, usable, p.oppCap ? maxOpp + 1 : 1e9);

    // Early plays.
    for (let guard = 0; guard < 4; guard++) {
      const cs = d.formable(r, balance < p.brokeBal ? 2 : p.minPlayLen);
      if (cs.length === 0) break;
      cs.sort((a, b) => d.classScore[b]! - d.classScore[a]!);
      const lam = this.lambda(v, balance);
      const keep = this.V(r, scen, lam);
      let bestVal = keep + p.playBias;
      let bestCls = -1;
      const n = Math.min(cs.length, p.playCands);
      for (let i = 0; i < n; i++) {
        if (i >= 1 && performance.now() > this.deadline) break;
        const w = cs[i]!;
        const o = w * 26;
        for (let c = 0; c < 26; c++) r[c]! -= d.classCounts[o + c]!;
        const val = d.classScore[w]! * (1 + lam) + this.V(r, scen, lam);
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

    // Bid.
    const lam = this.lambda(v, balance);
    this.lastLam = lam;
    const base = this.bestValue(r, scen, lam, balance);
    r[v.letter]!++;
    const withL = this.bestValue(r, scen, lam, balance);
    r[v.letter]!--;
    const delta = withL - base;
    let bid = 0;
    if (delta > 0) bid = (delta / lam) * p.bidMult * p.shade;
    if (v.auctionType === "FirstPrice") bid *= p.fpShade;
    if (VAL[v.letter]! >= 5) bid *= p.hvBidMult;
    if (delta > 0 && p.floorFrac > 0 && usable > 0) {
      const ep = this.expectedPrice(v.letter, v.round, v.totalAuctions) * this.pf;
      bid = Math.max(bid, p.floorFrac * ep);
    }
    if (p.hvFloor > 0 && usable >= p.hvMinUsable) {
      // J=9 K=10 Q=16 X=23 Z=25
      const base: Record<number, number> = { 9: 34, 10: 26, 16: 30, 23: 34, 25: 38 };
      const f = base[v.letter];
      const qOk = v.letter !== 16 || r[20]! > 0; // Q needs a U in hand
      if (f !== undefined && qOk && balance >= f * p.hvFloor + 12) bid = Math.max(bid, f * p.hvFloor);
    }
    if (p.hvFloor > 0) {
      const ceil: Record<number, number> = { 9: 40, 10: 30, 16: 36, 23: 40, 25: 48 };
      const cl = ceil[v.letter];
      if (cl !== undefined && usable >= 3) bid = Math.min(bid, cl);
    }
    if (bid >= 3) bid += p.bidAdd;
    if (p.oppCap) bid = Math.min(bid, maxOpp + 1);
    if (p.qcap < 1) bid = Math.min(bid, this.quantile(v.letter, v.round, v.totalAuctions, p.qcap) * this.pf * p.qcapMult);
    const frac = usable / v.totalAuctions;
    let cap = balance * (p.cap0 + (1 - p.cap0) * Math.pow(1 - frac, p.capPow));
    if (VAL[v.letter]! >= 5) cap = Math.max(cap, balance * p.hvCap);
    bid = Math.min(bid, cap);
    bid = Math.max(0, Math.min(balance, Math.floor(bid)));
    this.myBids.set(v.round, bid);
    return { words, bid };
  }

  onResult(v: View, rec: AuctionRecord) {
    if (rec.winner === this.seat) this.myWon[rec.letter]!++;
    // Learn how this table prices letters relative to history.
    const myBid = this.myBids.get(rec.round) ?? 0;
    let comp = -1;
    if (rec.winner === this.seat) comp = rec.paid; // exact highest competing bid
    else if (rec.winner >= 0 && rec.paid > myBid) comp = rec.paid * this.p.loseScale; // lower bound -> inflate
    if (comp > 0) {
      const exp = this.expectedPrice(rec.letter, rec.round, v.totalAuctions);
      this.obsAll += Math.log(Math.max(0.5, comp) / exp);
      this.obsAllN++;
    }
  }

  expectedPrice(c: number, round: number, total: number): number {
    const T = priceTable();
    const ph = Math.min(T[c]!.length - 1, Math.floor((round * T[c]!.length) / total));
    const key = c * 16 + ph;
    let m = this.meanCache.get(key);
    if (m === undefined) {
      const arr = T[c]![ph]!;
      let s = 0;
      for (const x of arr) s += x;
      m = s / Math.max(1, arr.length);
      this.meanCache.set(key, m);
    }
    return m;
  }

  quantile(c: number, round: number, total: number, q: number): number {
    const T = priceTable();
    const ph = Math.min(T[c]!.length - 1, Math.floor((round * T[c]!.length) / total));
    const key = c * 1000 + ph * 100 + Math.round(q * 100);
    let m = this.qCache.get(key);
    if (m === undefined) {
      const arr = T[c]![ph]!.slice().sort((a, b) => a - b);
      m = arr[Math.min(arr.length - 1, Math.floor(q * arr.length))] ?? 10;
      this.qCache.set(key, m);
    }
    return m;
  }

  // Multiplicative price factor for this table (geometric mean ratio, shrunk to 1).
  priceFactor(): number {
    const w = this.p.learnPrior;
    if (this.p.learnPrices <= 0) return 1;
    return Math.exp((this.obsAll / (w + this.obsAllN)) * this.p.learnPrices);
  }
}
