// Match lineups for experiments.
import { Dict, Partitioner } from "./dict.ts";
import { Game, Rng, SimBot, type Strategy } from "./game.ts";
import { GreedyBot, StarterBot, type GreedyParams } from "./bots/basic.ts";
import { Apex } from "./bots/apex.ts";
import { Apex2 } from "./bots/apex2.ts";
import { NetPartition } from "./netpart.ts";
import { marketGame } from "./market.ts";

export const GREEDY_FIELD: GreedyParams[] = [
  { name: "G-lucent", a: 8.5, b: 2.8, synergy: 3, maxFrac: 0.5, minPlayLen: 7, endDump: true, noise: 2 },
  { name: "G-bron", a: 8, b: 2.6, synergy: 2, maxFrac: 0.45, minPlayLen: 7, endDump: true, noise: 2 },
  { name: "G-thud", a: 11, b: 3.3, synergy: 3, maxFrac: 0.35, minPlayLen: 6, endDump: true, noise: 2 },
  { name: "G-wide", a: 7, b: 2.5, synergy: 4, maxFrac: 0.6, minPlayLen: 7, endDump: true, noise: 2 },
  { name: "G-hot", a: 12, b: 3.5, synergy: 0, maxFrac: 0.3, minPlayLen: 5, endDump: true, noise: 2 },
  { name: "G-short", a: 9, b: 3, synergy: 2, maxFrac: 0.4, minPlayLen: 4, endDump: true, noise: 2 },
];

let SHARED_PART: Partitioner | undefined;
let SHARED_NP: NetPartition | undefined;

function rotate<T>(arr: T[], k: number): T[] {
  const n = arr.length;
  return arr.map((_, i) => arr[(i + k) % n]!);
}

export function buildMatch(
  d: Dict,
  lineup: string,
  seed: number,
  params: Record<string, unknown>,
): Game {
  SHARED_PART ??= new Partitioner(d);
  const part = SHARED_PART;
  const rng = new Rng(seed * 31 + 7);
  SHARED_NP ??= new NetPartition(d);
  const np = SHARED_NP;
  const apex = (p: Record<string, unknown> = params, name?: string) =>
    (p.v1 ? new Apex(d, { ...(p as object), name: name ?? (p.name as string) ?? "Apex" }, part)
      : new Apex2(d, { ...(p as object), name: name ?? (p.name as string) ?? "Apex2" }, np)) as Strategy;
  const greedy = (i: number) => new GreedyBot(d, GREEDY_FIELD[i]!, part);
  let lineupArr: Strategy[];
  switch (lineup) {
    case "market":
      if (params.greedy !== undefined) {
        const gp = { ...GREEDY_FIELD[params.greedy as number]!, ...(params as object) } as GreedyParams;
        return marketGame(d, new GreedyBot(d, gp, part), seed);
      }
      return marketGame(d, apex(), seed);
    case "sims": {
      const kinds = ["Cheapskate", "ValueBidder", "Aggressive", "ValueBidder", "Aggressive", "Cheapskate"] as const;
      const names = ["Cheapo-sim", "Valor-sim", "Brutus-sim", "Hagrid-sim", "Maverick-sim", "Snippet-sim"];
      const idx = [0, 1, 2, 3, 4, 5];
      for (let i = 5; i > 0; i--) {
        const j = rng.int(0, i);
        [idx[i], idx[j]] = [idx[j]!, idx[i]!];
      }
      lineupArr = [apex(), ...idx.slice(0, 5).map((i) => new SimBot(kinds[i]!, names[i]))];
      break;
    }
    case "starter":
      lineupArr = [apex(), new StarterBot(d), new StarterBot(d), greedy(0), greedy(1), greedy(2)];
      lineupArr[1]!.name = "Starter1";
      lineupArr[2]!.name = "Starter2";
      break;
    case "field": {
      // Apex vs 5 of the 6 greedy profiles
      const drop = rng.int(0, 5);
      const gs = [0, 1, 2, 3, 4, 5].filter((i) => i !== drop).map(greedy);
      lineupArr = [apex(), ...gs];
      break;
    }
    case "small2":
      lineupArr = [apex(), greedy(3)];
      break;
    case "small3":
      lineupArr = [apex(), greedy(3), greedy(0)];
      break;
    case "small4":
      lineupArr = [apex(), greedy(3), greedy(0), greedy(1)];
      break;
    case "selfsmall2": {
      const base = (params.base as Record<string, unknown>) ?? {};
      lineupArr = [apex(params, "Cand"), apex(base, "Base")];
      break;
    }
    case "greedyonly":
      lineupArr = [0, 1, 2, 3, 4, 5].map(greedy);
      break;
    case "vsbase": {
      // Candidate vs a default Apex and 4 greedy bots.
      const base = (params.base as Record<string, unknown>) ?? {};
      const drop = rng.int(0, 5);
      const drop2 = (drop + 1 + rng.int(0, 4)) % 6;
      const gs = [0, 1, 2, 3, 4, 5].filter((i) => i !== drop && i !== drop2).map(greedy);
      lineupArr = [apex(params, "Cand"), apex(base, "Base"), ...gs];
      break;
    }
    case "selfplay": {
      const base = (params.base as Record<string, unknown>) ?? {};
      lineupArr = [apex(params, "Cand"), apex(base, "Base1"), apex(base, "Base2"), greedy(0), greedy(1), greedy(2)];
      break;
    }
    default:
      throw new Error(`unknown lineup ${lineup}`);
  }
  return new Game(d, rotate(lineupArr, seed % lineupArr.length), seed);
}
