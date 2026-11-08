// Cost-aware exact partition ("net partition").
//
// We hold `free` tiles (already ours) and may additionally acquire extra
// copies of letters at given costs (in points). Find the set of disjoint
// words maximising  sum(word scores) - sum(cost of acquired copies used).
//
// Copies of a letter are interchangeable inside words, so an optimal plan
// always uses the cheapest copies; cost depends only on how many copies of
// each letter are used in total. State = remaining count per letter; the
// copies remaining are always the most expensive ones.
//
// Search: smallest letter present is either never used again (drop all its
// remaining copies) or appears in a word whose sorted key starts with it.
// Fail-soft alpha bound with memo keyed by a mixed-radix integer.

import { Dict, VAL } from "./dict.ts";

export class NetPartition {
  d: Dict;
  // per-solve state
  private n = new Int32Array(26); // total copies
  private cum: Float64Array[] = []; // cum[c][u] = cost of first u copies
  private suf: Float64Array[] = []; // suf[c][u] = sum_{j>=u} max(0, 3v - cost_j)
  private radix = new Float64Array(26);
  private buckets: Int32Array[] = []; // candidates by first letter, sorted by score desc
  private exact = new Map<number, number>();
  private upper = new Map<number, number>();
  private choice = new Map<number, number>();
  nodes = 0;
  private lstart = new Map<number, number>();
  private flat = new Int32Array(1 << 16);
  private bstart: Int32Array[] = [];

  constructor(d: Dict) {
    this.d = d;
    for (let c = 0; c < 26; c++) {
      this.cum.push(new Float64Array(1));
      this.suf.push(new Float64Array(1));
      this.buckets.push(new Int32Array(0));
    }
  }

  // free: counts we own. extra[c]: costs (any order) of acquirable copies.
  solve(
    free: ArrayLike<number>,
    extra: number[][] | null,
    wantPlan = false,
    minLen = 2,
  ): { value: number; plan: number[] } {
    const d = this.d;
    const n = this.n;
    for (let c = 0; c < 26; c++) {
      const f = free[c]!;
      const ex = extra ? extra[c]! : [];
      const tot = f + ex.length;
      n[c] = tot;
      const costs = ex.length > 1 ? ex.slice().sort((a, b) => a - b) : ex;
      const cum = new Float64Array(tot + 1);
      for (let u = 1; u <= tot; u++) cum[u] = cum[u - 1]! + (u <= f ? 0 : costs[u - 1 - f]!);
      const suf = new Float64Array(tot + 1);
      for (let u = tot - 1; u >= 0; u--) {
        const cost = u < f ? 0 : costs[u - f]!;
        suf[u] = suf[u + 1]! + Math.max(0, 3 * VAL[c]! - cost);
      }
      this.cum[c] = cum;
      this.suf[c] = suf;
    }
    let rad = 1;
    for (let c = 0; c < 26; c++) {
      this.radix[c] = rad;
      rad *= n[c]! + 1;
    }
    // Candidate words formable from the full multiset.
    const cands = d.formable(n as unknown as Uint8Array, minLen);
    const tmp: number[][] = [];
    for (let c = 0; c < 26; c++) tmp.push([]);
    const counts = d.classCounts;
    const sc0 = d.classScore;
    for (const w of cands) {
      const o = w * 26;
      let first = -1;
      let minCost = 0;
      for (let c = 0; c < 26; c++) {
        const m = counts[o + c]!;
        if (!m) continue;
        if (first < 0) first = c;
        minCost += this.cum[c]![m]!;
      }
      // Never worth playing even with its cheapest copies.
      if (sc0[w]! - minCost <= 0) continue;
      tmp[first]!.push(w);
    }
    const sc = d.classScore;
    for (let c = 0; c < 26; c++) {
      const arr = tmp[c]!;
      arr.sort((a, b) => sc[b]! - sc[a]!);
      this.buckets[c] = Int32Array.from(arr);
    }
    // Compact letter lists per class used in this solve.
    this.lstart.clear();
    let pos = 0;
    for (let c = 0; c < 26; c++) {
      const b = this.buckets[c]!;
      for (let i = 0; i < b.length; i++) {
        const w = b[i]!;
        const o = w * 26;
        this.lstart.set(w, pos);
        for (let L = 0; L < 26; L++) {
          const m = counts[o + L]!;
          if (!m) continue;
          if (pos + 2 >= this.flat.length) {
            const nf = new Int32Array(this.flat.length * 2);
            nf.set(this.flat);
            this.flat = nf;
          }
          this.flat[pos++] = L;
          this.flat[pos++] = m;
        }
        this.flat[pos++] = -1;
      }
    }
    // bucket -> parallel start offsets
    for (let c = 0; c < 26; c++) {
      const b = this.buckets[c]!;
      const st = new Int32Array(b.length);
      for (let i = 0; i < b.length; i++) st[i] = this.lstart.get(b[i]!)!;
      this.bstart[c] = st;
    }
    this.exact.clear();
    this.upper.clear();
    this.choice.clear();
    const r = new Int32Array(26);
    r.set(n);
    let key = 0;
    for (let c = 0; c < 26; c++) key += n[c]! * this.radix[c]!;
    const value = this.rec(r, key, -1);
    const plan: number[] = [];
    if (wantPlan) {
      // Replay choices.
      let k = key;
      for (;;) {
        const ch = this.choice.get(k);
        if (ch === undefined) break;
        if (ch < 0) {
          // dropped letter (-1 - c)
          const c = -1 - ch;
          k -= r[c]! * this.radix[c]!;
          r[c] = 0;
          continue;
        }
        plan.push(ch);
        const o = ch * 26;
        for (let c = 0; c < 26; c++) {
          const m = counts[o + c]!;
          if (m) {
            r[c]! -= m;
            k -= m * this.radix[c]!;
          }
        }
      }
    }
    return { value, plan };
  }

  private ub(r: Int32Array): number {
    let s = 0;
    for (let c = 0; c < 26; c++) {
      const rc = r[c]!;
      if (rc) s += this.suf[c]![this.n[c]! - rc]!;
    }
    return s;
  }

  private rec(r: Int32Array, key: number, alpha: number): number {
    let first = -1;
    for (let c = 0; c < 26; c++)
      if (r[c]! > 0) {
        first = c;
        break;
      }
    if (first < 0) return 0;
    const ub = this.ub(r);
    if (ub <= alpha) return ub;
    const ex = this.exact.get(key);
    if (ex !== undefined) return ex;
    const up = this.upper.get(key);
    if (up !== undefined && up <= alpha) return up;
    this.nodes++;
    const d = this.d;
    const counts = d.classCounts;
    const sc = d.classScore;
    const n = this.n;
    const radix = this.radix;
    let best = -Infinity;
    let bestCh = 0;
    let a = alpha;
    const bucket = this.buckets[first]!;
    const bst = this.bstart[first]!;
    const flat = this.flat;
    for (let i = 0; i < bucket.length; i++) {
      const w = bucket[i]!;
      const s = sc[w]!;
      if (s + ub <= a) break; // sorted by score desc: no later word can help
      let p = bst[i]!;
      let fits = true;
      let cost = 0;
      let dkey = 0;
      let dub = 0;
      for (; flat[p]! >= 0; p += 2) {
        const c = flat[p]!;
        const m = flat[p + 1]!;
        const rc = r[c]!;
        if (m > rc) {
          fits = false;
          break;
        }
        const used = n[c]! - rc;
        const cum = this.cum[c]!;
        cost += cum[used + m]! - cum[used]!;
        const suf = this.suf[c]!;
        dub += suf[used]! - suf[used + m]!;
        dkey += m * radix[c]!;
      }
      if (!fits) continue;
      const net = s - cost;
      const restUb = ub - dub;
      if (net + restUb <= a) continue;
      for (p = bst[i]!; flat[p]! >= 0; p += 2) r[flat[p]!]! -= flat[p + 1]!;
      const v = net + this.rec(r, key - dkey, a - net);
      for (p = bst[i]!; flat[p]! >= 0; p += 2) r[flat[p]!]! += flat[p + 1]!;
      if (v > best) {
        best = v;
        bestCh = w;
        if (v > a) a = v;
      }
    }
    // Drop all remaining copies of `first`.
    const rf = r[first]!;
    r[first] = 0;
    const v = this.rec(r, key - rf * radix[first]!, a);
    r[first] = rf;
    if (v > best) {
      best = v;
      bestCh = -1 - first;
    }
    if (best > alpha) {
      this.exact.set(key, best);
      this.choice.set(key, bestCh);
    } else {
      this.upper.set(key, Math.min(best, up ?? Infinity));
    }
    return best;
  }
}
