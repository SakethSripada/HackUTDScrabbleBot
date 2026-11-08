// Coordinate-descent tuner with common random numbers.
// node src/opt.ts <lineup> <games> '<start json>' '<space json: {key:[min,max,step,"mul"|"add"]}>' <target> [passes]
import { runParallel } from "./run.ts";
import * as fs from "node:fs";
const lineup = process.argv[2]!;
const games = Number(process.argv[3]);
let cur: Record<string, number> = JSON.parse(process.argv[4]!);
const space: Record<string, [number, number, number, string]> = JSON.parse(process.argv[5]!);
const target = process.argv[6] ?? "Apex2";
const passes = Number(process.argv[7] ?? 3);
const cache = new Map<string, number>();
async function evalp(p: Record<string, number>): Promise<number> {
  const k = JSON.stringify(p);
  if (cache.has(k)) return cache.get(k)!;
  const res = await runParallel(lineup, games, p, 1000);
  let s = 0;
  for (const g of res) {
    const i = g.names.findIndex((n) => n.startsWith(target) || n === "Cand");
    if (lineup === "market") s += g.scores[i]!;
    else {
      // score margin vs best opponent: rewards winning
      const best = Math.max(...g.scores.filter((_, j) => j !== i));
      s += g.scores[i]! - 0.5 * best;
    }
  }
  const v = s / res.length;
  cache.set(k, v);
  console.log(`${v.toFixed(2)}  ${k}`);
  return v;
}
let best = await evalp(cur);
for (let pass = 0; pass < passes; pass++) {
  let improved = false;
  for (const [key, [lo, hi, step, mode]] of Object.entries(space)) {
    for (const dir of [1, -1]) {
      for (;;) {
        const v0 = cur[key]!;
        let v1 = mode === "mul" ? (dir > 0 ? v0 * step : v0 / step) : v0 + dir * step;
        v1 = Math.round(v1 * 1000) / 1000;
        if (v1 < lo || v1 > hi) break;
        const cand = { ...cur, [key]: v1 };
        const val = await evalp(cand);
        if (val > best + 0.8) {
          best = val;
          cur = cand;
          improved = true;
          console.log(`ACCEPT ${key}=${v1} -> ${best.toFixed(2)}`);
          fs.writeFileSync("../results/opt-best.json", JSON.stringify({ best, cur }, null, 1));
        } else break;
      }
    }
  }
  if (!improved) break;
}
console.log("FINAL", best.toFixed(2), JSON.stringify(cur));
