// Parallel experiment runner.
//   node src/run.ts <lineup> <games> [jsonParamsForApex] [label]
// Lineups are defined in lineups.ts. Prints per-strategy averages.

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import * as os from "node:os";
import { Dict } from "./dict.ts";
import { winVsHistory } from "./market.ts";
import { buildMatch } from "./lineups.ts";

interface Job {
  lineup: string;
  seeds: number[];
  params: Record<string, unknown>;
}

interface GameOut {
  seed: number;
  names: string[];
  scores: number[];
  balances: number[];
  leftover: number[];
  bought: number[];
  paid: number[];
  ms: number;
}

if (!isMainThread) {
  const d = new Dict();
  const job = workerData as Job;
  const out: GameOut[] = [];
  for (const seed of job.seeds) {
    const t = performance.now();
    const g = buildMatch(d, job.lineup, seed, job.params);
    const r = g.run();
    const n = r.scores.length;
    const bought = new Array(n).fill(0);
    const paid = new Array(n).fill(0);
    for (const a of r.auctions)
      if (a.winner >= 0) {
        bought[a.winner]++;
        paid[a.winner] += a.paid;
      }
    out.push({
      seed,
      names: r.names,
      scores: r.scores,
      balances: r.balances,
      leftover: r.leftover,
      bought,
      paid,
      ms: performance.now() - t,
    });
    parentPort!.postMessage({ progress: 1 });
  }
  parentPort!.postMessage({ done: out });
}

export async function runParallel(
  lineup: string,
  games: number,
  params: Record<string, unknown> = {},
  seed0 = 1,
  threads = Math.max(1, os.cpus().length),
): Promise<GameOut[]> {
  const seeds = Array.from({ length: games }, (_, i) => seed0 + i * 7919);
  const chunks: number[][] = Array.from({ length: threads }, () => []);
  seeds.forEach((s, i) => chunks[i % threads]!.push(s));
  const results: GameOut[] = [];
  await Promise.all(
    chunks
      .filter((c) => c.length > 0)
      .map(
        (c) =>
          new Promise<void>((resolve, reject) => {
            const w = new Worker(new URL(import.meta.url), {
              workerData: { lineup, seeds: c, params } satisfies Job,
            });
            w.on("message", (m) => {
              if (m.done) {
                results.push(...m.done);
                resolve();
              }
            });
            w.on("error", reject);
          }),
      ),
  );
  results.sort((a, b) => a.seed - b.seed);
  return results;
}

export function summarize(res: GameOut[], label = "") {
  const by = new Map<
    string,
    { n: number; score: number; sq: number; win: number; rank: number; bal: number; left: number; bought: number; paid: number }
  >();
  for (const g of res) {
    const order = g.scores.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0]);
    g.names.forEach((nm, i) => {
      if (nm === "Idle" || nm === "Market") return;
      const e = by.get(nm) ?? { n: 0, score: 0, sq: 0, win: 0, rank: 0, bal: 0, left: 0, bought: 0, paid: 0 };
      e.n++;
      e.score += g.scores[i]!;
      e.sq += g.scores[i]! ** 2;
      const better = g.scores.filter((s, j) => j !== i && s > g.scores[i]!).length;
      const ties = g.scores.filter((s, j) => j !== i && s === g.scores[i]!).length;
      if (better === 0) e.win += 1 / (1 + ties);
      e.rank += better;
      e.bal += g.balances[i]!;
      e.left += g.leftover[i]!;
      e.bought += g.bought[i]!;
      e.paid += g.paid[i]!;
      by.set(nm, e);
      void order;
    });
  }
  const ms = res.reduce((a, g) => a + g.ms, 0) / res.length;
  console.log(`== ${label} (${res.length} games, ${ms.toFixed(0)} ms/game)`);
  const rows = [...by.entries()].sort((a, b) => b[1].score / b[1].n - a[1].score / a[1].n);
  for (const [nm, e] of rows) {
    const mean = e.score / e.n;
    const sd = Math.sqrt(Math.max(0, e.sq / e.n - mean * mean));
    let extra = "";
    if (res[0]!.names.includes("Market")) {
      // expected win-rate vs historical tables
      let w = 0;
      let rk = 0;
      for (const g of res) {
        const i = g.names.indexOf(nm);
        const h = winVsHistory(g.scores[i]!);
        w += h.win;
        rk += h.rank;
      }
      extra = ` histWin=${((100 * w) / res.length).toFixed(1)}% histRank=${(rk / res.length).toFixed(2)}`;
    }
    console.log(
      `${nm.padEnd(18)} n=${e.n} avg=${mean.toFixed(1)} ±${(sd / Math.sqrt(e.n)).toFixed(1)} sd=${sd.toFixed(0)} win=${((100 * e.win) / e.n).toFixed(1)}% rank=${(e.rank / e.n).toFixed(2)} bought=${(e.bought / e.n).toFixed(1)} paid/t=${(e.paid / Math.max(1, e.bought)).toFixed(1)} bal=${(e.bal / e.n).toFixed(1)} left=${(e.left / e.n).toFixed(1)}${extra}`,
    );
  }
}

if (isMainThread && process.argv[1] && process.argv[1].endsWith("run.ts")) {
  const lineup = process.argv[2] ?? "sims";
  const games = Number(process.argv[3] ?? 64);
  const params = process.argv[4] ? JSON.parse(process.argv[4]) : {};
  const label = process.argv[5] ?? `${lineup} ${JSON.stringify(params)}`;
  const t = performance.now();
  const res = await runParallel(lineup, games, params);
  summarize(res, label);
  console.log(`wall ${((performance.now() - t) / 1000).toFixed(1)}s`);
}
