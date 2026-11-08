// node src/sweep.ts <lineup> <games> '<base json>' '<grid json: {key:[values]}>'
import { runParallel } from "./run.ts";
import { winVsHistory } from "./market.ts";
const lineup = process.argv[2]!;
const games = Number(process.argv[3]);
const base = JSON.parse(process.argv[4] ?? "{}");
const grid: Record<string, unknown[]> = JSON.parse(process.argv[5] ?? "{}");
const keys = Object.keys(grid);
const combos: Record<string, unknown>[] = [{}];
for (const k of keys) {
  const next: Record<string, unknown>[] = [];
  for (const c of combos) for (const v of grid[k]!) next.push({ ...c, [k]: v });
  combos.splice(0, combos.length, ...next);
}
const target = process.argv[6] ?? "Apex";
const rows: [number, string][] = [];
for (const c of combos) {
  const params = { ...base, ...c };
  const res = await runParallel(lineup, games, params);
  let s = 0, w = 0, win = 0, bal = 0;
  for (const g of res) {
    const i = g.names.findIndex((n) => n.startsWith(target) || n === "Cand");
    s += g.scores[i]!; bal += g.balances[i]!;
    if (lineup === "market") w += winVsHistory(g.scores[i]!).win;
    else if (g.scores.every((x, j) => j === i || x < g.scores[i]!)) win++;
  }
  const line = `${JSON.stringify(c)} avg=${(s / res.length).toFixed(1)} ${lineup === "market" ? "histWin=" + ((100 * w) / res.length).toFixed(1) : "win=" + ((100 * win) / res.length).toFixed(1)}% bal=${(bal / res.length).toFixed(0)}`;
  console.log(line);
  rows.push([s / res.length, line]);
}
rows.sort((a, b) => b[0] - a[0]);
console.log("--- best ---");
for (const r of rows.slice(0, 5)) console.log(r[1]);
