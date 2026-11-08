// node src/trace.ts <lineup> <seed> '<params>'  -> per-auction trace for seat of our bot
import { Dict, rackToString } from "./dict.ts";
import { buildMatch } from "./lineups.ts";
const d = new Dict();
const g = buildMatch(d, process.argv[2] ?? "market", Number(process.argv[3] ?? 1), JSON.parse(process.argv[4] ?? "{}"));
const me = g.strategies.findIndex((s) => s.name.startsWith("Apex") || s.name === "Cand");
const strat = g.strategies[me]!;
const orig = strat.act.bind(strat);
let lastRack = "";
strat.act = (v) => {
  const t = performance.now();
  const a = orig(v);
  const lam = (strat as any).lastLam ?? "";
  lastRack = rackToString(v.rack);
  console.log(`r${v.round} ${String.fromCharCode(65 + v.letter)} rack=${lastRack} bal=${v.balance} bid=${a.bid} ${a.words.join(",")} ${lam !== "" ? "lam=" + Number(lam).toFixed(2) : ""} ${(performance.now() - t).toFixed(0)}ms`);
  return a;
};
const res = g.run();
const won = res.auctions.filter((a) => a.winner === me);
console.log("score", res.scores[me], "bal", res.balances[me], "won", won.length, "words", res.words.filter((w) => w.seat === me).map((w) => w.word + ":" + w.score).join(" "));
for (const a of res.auctions) if (a.winner === me) process.stdout.write(`${String.fromCharCode(65 + a.letter)}@${a.paid} `);
console.log();
