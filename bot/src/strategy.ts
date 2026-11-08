// Strategy factory for the live bot.
import type { Dict } from "../../engine/src/dict.ts";
import type { Strategy } from "../../engine/src/game.ts";
import { Apex } from "../../engine/src/bots/apex.ts";
import { Apex2 } from "../../engine/src/bots/apex2.ts";
import { GreedyBot } from "../../engine/src/bots/basic.ts";
import { GREEDY_FIELD } from "../../engine/src/lineups.ts";

export function makeStrategy(d: Dict, name: string, paramsJson?: string): Strategy {
  const p = paramsJson ? JSON.parse(paramsJson) : {};
  switch (name) {
    case "apex1":
      return new Apex(d, { K: 16, exactMax: 9, ...p, name: "apex1" });
    case "apex2":
      return new Apex2(d, { ...p, name: "apex2" });
    case "greedy":
      return new GreedyBot(d, { ...GREEDY_FIELD[0]!, ...p, name: "greedy" });
    default:
      throw new Error(`unknown strategy ${name}`);
  }
}
