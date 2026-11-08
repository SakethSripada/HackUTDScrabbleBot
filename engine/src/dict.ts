// Word engine: anagram classes, a sorted-key trie, formable-word enumeration
// and an exact "best partition of a rack into disjoint words" solver.
//
// Score depends only on the multiset of letters (face values x length
// multiplier), so every anagram class has a single score and we only need
// one representative word per class.

import * as fs from "node:fs";
import * as path from "node:path";

export const VAL = [
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10,
];
// Standard Scrabble distribution, no blanks. 98 tiles.
export const BAG = [
  9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1,
];
export const A = 65;
export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function lengthScore(base: number, len: number): number {
  if (len <= 3) return base;
  if (len === 4) return Math.floor((base * 3) / 2);
  if (len === 5) return base * 2;
  if (len === 6) return Math.floor((base * 5) / 2);
  return base * 3;
}

export function wordScore(word: string): number {
  let b = 0;
  for (let i = 0; i < word.length; i++) b += VAL[word.charCodeAt(i) - A]!;
  return lengthScore(b, word.length);
}

export class Dict {
  // Anagram classes
  nClasses = 0;
  classWord: string[] = [];
  classScore: Int32Array;
  classLen: Int32Array;
  classBase: Int32Array;
  classCounts: Uint8Array; // 26 per class
  // Trie over sorted keys
  child: Int32Array; // 26 per node
  term: Int32Array; // class id or -1
  nNodes = 0;
  // Max class length under each node (for pruning)
  words: Set<string>;

  constructor(wordlistPath?: string) {
    const p =
      wordlistPath ??
      path.join(path.dirname(new URL(import.meta.url).pathname), "..", "wordlist.txt");
    const raw = fs.readFileSync(p, "utf8").split("\n");
    const keyToClass = new Map<string, number>();
    const words: string[] = [];
    for (const l of raw) {
      const w = l.trim().toUpperCase();
      if (w.length < 2 || !/^[A-Z]+$/.test(w)) continue;
      words.push(w);
    }
    this.words = new Set(words);
    const classKeys: string[] = [];
    for (const w of words) {
      const key = w.split("").sort().join("");
      if (!keyToClass.has(key)) {
        keyToClass.set(key, classKeys.length);
        classKeys.push(key);
        this.classWord.push(w);
      }
    }
    const n = classKeys.length;
    this.nClasses = n;
    this.classScore = new Int32Array(n);
    this.classLen = new Int32Array(n);
    this.classBase = new Int32Array(n);
    this.classCounts = new Uint8Array(n * 26);
    let cap = 1 << 19;
    let child = new Int32Array(cap * 26).fill(-1);
    let term = new Int32Array(cap).fill(-1);
    let nNodes = 1;
    for (let ci = 0; ci < n; ci++) {
      const key = classKeys[ci]!;
      let base = 0;
      let node = 0;
      for (let i = 0; i < key.length; i++) {
        const c = key.charCodeAt(i) - A;
        base += VAL[c]!;
        this.classCounts[ci * 26 + c]!++;
        let nx = child[node * 26 + c]!;
        if (nx < 0) {
          if (nNodes >= cap) {
            const ncap = cap * 2;
            const nc = new Int32Array(ncap * 26).fill(-1);
            nc.set(child);
            const nt = new Int32Array(ncap).fill(-1);
            nt.set(term);
            child = nc;
            term = nt;
            cap = ncap;
          }
          nx = nNodes++;
          child[node * 26 + c] = nx;
        }
        node = nx;
      }
      term[node] = ci;
      this.classLen[ci] = key.length;
      this.classBase[ci] = base;
      this.classScore[ci] = lengthScore(base, key.length);
    }
    this.child = child;
    this.term = term;
    this.nNodes = nNodes;
  }

  isWord(w: string): boolean {
    return this.words.has(w);
  }

  // All anagram classes formable from `rack` (counts[26]). `minLen` filter.
  formable(rack: Uint8Array | number[], minLen = 2): number[] {
    const out: number[] = [];
    const r = Uint8Array.from(rack as ArrayLike<number>);
    const child = this.child;
    const term = this.term;
    const classLen = this.classLen;
    const rec = (node: number, from: number) => {
      const t = term[node]!;
      if (t >= 0 && classLen[t]! >= minLen) out.push(t);
      for (let c = from; c < 26; c++) {
        if (r[c]! === 0) continue;
        const nx = child[node * 26 + c]!;
        if (nx < 0) continue;
        r[c]!--;
        rec(nx, c);
        r[c]!++;
      }
    };
    rec(0, 0);
    return out;
  }

  // Best single-word score from rack (and the class).
  bestWord(rack: Uint8Array | number[], minLen = 2): { cls: number; score: number } {
    let best = -1;
    let bestScore = 0;
    for (const c of this.formable(rack, minLen)) {
      const s = this.classScore[c]!;
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    return { cls: best, score: bestScore };
  }
}

// Exact maximum total score from splitting a rack into disjoint words
// (leftover tiles score 0). Fail-soft alpha search with memoisation on the
// rack multiset: take the smallest letter present; either it's unused, or it
// is in a word whose sorted key starts with it (all other letters are >= it).
// Upper bound for any rack: 3 x face value.
export class Partitioner {
  d: Dict;
  exact = new Map<string, number>();
  upper = new Map<string, number>();
  memoLimit: number;
  nodes = 0;
  constructor(d: Dict, memoLimit = 1_000_000) {
    this.d = d;
    this.memoLimit = memoLimit;
  }

  clear() {
    this.exact.clear();
    this.upper.clear();
  }

  private key(r: Uint8Array): string {
    return String.fromCharCode.apply(null, r as unknown as number[]);
  }

  best(rack: Uint8Array | number[]): number {
    const r = Uint8Array.from(rack as ArrayLike<number>);
    if (this.exact.size + this.upper.size > this.memoLimit) this.clear();
    let face = 0;
    for (let c = 0; c < 26; c++) face += r[c]! * VAL[c]!;
    return this.solve(r, face, -1);
  }

  // Candidate classes containing `first` as their smallest letter, formable
  // from r (r already excludes nothing). Sorted by score desc.
  private cands(r: Uint8Array, first: number): number[] {
    const d = this.d;
    const out: number[] = [];
    const node0 = d.child[first]!;
    if (node0 < 0) return out;
    const child = d.child;
    const term = d.term;
    r[first]!--;
    const rec = (node: number, from: number) => {
      const t = term[node]!;
      if (t >= 0) out.push(t);
      for (let c = from; c < 26; c++) {
        if (r[c]! === 0) continue;
        const nx = child[node * 26 + c]!;
        if (nx < 0) continue;
        r[c]!--;
        rec(nx, c);
        r[c]!++;
      }
    };
    rec(node0, first);
    r[first]!++;
    const sc = d.classScore;
    out.sort((a, b) => sc[b]! - sc[a]!);
    return out;
  }

  private solve(r: Uint8Array, face: number, alpha: number): number {
    const ub = 3 * face;
    if (ub <= alpha) return ub;
    let first = -1;
    for (let c = 0; c < 26; c++)
      if (r[c]! > 0) {
        first = c;
        break;
      }
    if (first < 0) return 0;
    const k = this.key(r);
    const ex = this.exact.get(k);
    if (ex !== undefined) return ex;
    const up = this.upper.get(k);
    if (up !== undefined && up <= alpha) return up;
    this.nodes++;
    const d = this.d;
    let best = -1;
    let a = alpha;
    // Words containing `first`.
    const cs = this.cands(r, first);
    const counts = d.classCounts;
    const base = d.classBase;
    const sc = d.classScore;
    for (let i = 0; i < cs.length; i++) {
      const w = cs[i]!;
      const s = sc[w]!;
      const rem = face - base[w]!;
      if (s + 3 * rem <= a) continue;
      const o = w * 26;
      for (let c = first; c < 26; c++) r[c]! -= counts[o + c]!;
      const v = s + this.solve(r, rem, a - s);
      for (let c = first; c < 26; c++) r[c]! += counts[o + c]!;
      if (v > best) {
        best = v;
        if (v > a) a = v;
      }
    }
    // `first` tile unused.
    r[first]!--;
    const v = this.solve(r, face - VAL[first]!, a);
    r[first]!++;
    if (v > best) best = v;
    if (best > alpha) this.exact.set(k, best);
    else this.upper.set(k, Math.min(best, up ?? Infinity));
    return best;
  }

  // Reconstruct a list of classes achieving best(rack).
  plan(rack: Uint8Array | number[]): number[] {
    const r = Uint8Array.from(rack as ArrayLike<number>);
    let target = this.best(r);
    const out: number[] = [];
    const d = this.d;
    while (target > 0) {
      let first = -1;
      let face = 0;
      for (let c = 0; c < 26; c++) {
        if (r[c]! > 0 && first < 0) first = c;
        face += r[c]! * VAL[c]!;
      }
      if (first < 0) break;
      let found = false;
      for (const w of this.cands(r, first)) {
        const s = d.classScore[w]!;
        const o = w * 26;
        for (let c = 0; c < 26; c++) r[c]! -= d.classCounts[o + c]!;
        const rest = this.solve(r, face - d.classBase[w]!, target - s - 1);
        if (s + rest === target) {
          out.push(w);
          target -= s;
          found = true;
          break;
        }
        for (let c = 0; c < 26; c++) r[c]! += d.classCounts[o + c]!;
      }
      if (!found) r[first]!--; // tile unused
    }
    return out;
  }
}

export function rackFromString(s: string): Uint8Array {
  const r = new Uint8Array(26);
  for (const ch of s.toUpperCase()) {
    const c = ch.charCodeAt(0) - A;
    if (c >= 0 && c < 26) r[c]!++;
  }
  return r;
}

export function rackToString(r: ArrayLike<number>): string {
  let s = "";
  for (let c = 0; c < 26; c++) for (let i = 0; i < r[c]!; i++) s += LETTERS[c];
  return s;
}

export function rackSize(r: ArrayLike<number>): number {
  let n = 0;
  for (let c = 0; c < 26; c++) n += r[c]!;
  return n;
}

export function rackFace(r: ArrayLike<number>): number {
  let n = 0;
  for (let c = 0; c < 26; c++) n += r[c]! * VAL[c]!;
  return n;
}

// Fast approximate partition: beam over "take one of the top-B words, then
// recurse greedily". Exact for small racks via Partitioner fallback.
export function greedyPartition(
  d: Dict,
  rack: Uint8Array,
  beam = 3,
  depth = 2,
): number {
  const r = Uint8Array.from(rack);
  return greedyRec(d, r, beam, depth);
}

function greedyRec(d: Dict, r: Uint8Array, beam: number, depth: number): number {
  const cs = d.formable(r, 2);
  if (cs.length === 0) return 0;
  const sc = d.classScore;
  // top `beam` by score
  const top: number[] = [];
  for (const c of cs) {
    if (top.length < beam) {
      top.push(c);
      top.sort((a, b) => sc[b]! - sc[a]!);
    } else if (sc[c]! > sc[top[top.length - 1]!]!) {
      top[top.length - 1] = c;
      top.sort((a, b) => sc[b]! - sc[a]!);
    }
  }
  let best = 0;
  const counts = d.classCounts;
  const b = depth > 0 ? top.length : 1;
  for (let i = 0; i < b; i++) {
    const w = top[i]!;
    const o = w * 26;
    for (let c = 0; c < 26; c++) r[c]! -= counts[o + c]!;
    const v = sc[w]! + greedyRec(d, r, beam, depth - 1);
    for (let c = 0; c < 26; c++) r[c]! += counts[o + c]!;
    if (v > best) best = v;
  }
  return best;
}
