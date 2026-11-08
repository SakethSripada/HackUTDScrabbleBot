// Live ScrabbleBot client. Runs an engine Strategy against the real server.
//
//   BOT_NONCE=<code> npm start        # first run: redeem a CLI nonce
//   npm start                         # later runs: uses .token
//   STRATEGY=apex1 PARAMS='{"lambda0":0.5}' npm start
//   TOURNAMENT_ID=2 npm start         # also register for a tournament
//
// Only subscribes to small global tables plus the current match's rows.

import { DbConnection } from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { Dict } from "../../engine/src/dict.ts";
import type { AuctionRecord, Strategy, View, WordRecord } from "../../engine/src/game.ts";
import { makeStrategy } from "./strategy.ts";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const TOKEN_PATH = path.join(ROOT, ".token");
const LOG_DIR = path.join(ROOT, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const BOT_NONCE = process.env.BOT_NONCE;
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const NO_LOBBY = process.env.NO_LOBBY === "1";
const MAX_MATCHES = Number(process.env.MAX_MATCHES ?? "1000000");

const d = new Dict();
// Optional live A/B: PARAMS_B alternates with PARAMS match by match.
const stratA: Strategy = makeStrategy(d, process.env.STRATEGY ?? "apex2", process.env.PARAMS);
const stratB: Strategy | null = process.env.PARAMS_B ? makeStrategy(d, process.env.STRATEGY ?? "apex2", process.env.PARAMS_B) : null;
let strategy: Strategy = stratA;
let variant = "A";
let abCounter = 0;
console.log(`[bot] strategy ${stratA.name}${stratB ? " with A/B" : ""}`);

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
let conn: DbConnection;

interface MatchCtx {
  id: bigint;
  sub: { unsubscribe(): void } | null;
  applied: boolean;
  seats: bigint[]; // bot ids by seat
  mySeat: number;
  reset: boolean;
  handledAuctions: Set<bigint>;
  resultsSeen: Set<bigint>;
  log: fs.WriteStream;
  bids: Map<bigint, number>;
}
let cur: MatchCtx | null = null;
let matchesPlayed = 0;

function ts() {
  return new Date().toISOString().slice(11, 23);
}

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function fail(what: string) {
  return (e: unknown) => console.warn(`[${ts()}] ${what} failed: ${e instanceof Error ? e.message : e}`);
}

function runningMatchForMe(): bigint | null {
  if (myBotId === null) return null;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const m = conn.db.matchState.id.find(p.matchId);
    if (m && m.status.tag === "Running") return p.matchId;
  }
  return null;
}

function joinLobby() {
  if (NO_LOBBY || myBotId === null) return;
  if (matchesPlayed >= MAX_MATCHES) {
    console.log("[bot] max matches reached; not rejoining");
    return;
  }
  if (cur) return;
  const open = [...conn.db.lobby.iter()].find((l) => l.status.tag === "Open");
  if (open && [...conn.db.lobbyMember.iter()].some((lm) => lm.lobbyId === open.id && lm.botId === myBotId))
    return;
  console.log(`[${ts()}] joining lobby`);
  conn.reducers.joinLobby({}).catch(fail("join lobby"));
}

function startMatch(matchId: bigint) {
  if (cur && cur.id === matchId) return;
  if (cur) endMatch();
  if (stratB) {
    abCounter++;
    const useB = abCounter % 2 === 0;
    strategy = useB ? stratB : stratA;
    variant = useB ? "B" : "A";
  }
  console.log(`[${ts()}] match ${matchId} starting (variant ${variant})`);
  const log = fs.createWriteStream(path.join(LOG_DIR, `match-${matchId}.jsonl`), { flags: "a" });
  cur = {
    id: matchId,
    sub: null,
    applied: false,
    seats: [],
    mySeat: -1,
    reset: false,
    handledAuctions: new Set(),
    resultsSeen: new Set(),
    log,
    bids: new Map(),
  };
  const m = matchId.toString();
  const c = cur;
  c.sub = conn
    .subscriptionBuilder()
    .onApplied(() => {
      c.applied = true;
      console.log(`[${ts()}] match ${m} subscription applied`);
      tick();
    })
    .onError((_ctx: unknown) => console.warn(`match ${m} subscription error`))
    .subscribe([
      `SELECT * FROM match_state WHERE id = ${m}`,
      `SELECT * FROM match_participant WHERE match_id = ${m}`,
      `SELECT * FROM auction WHERE match_id = ${m}`,
      `SELECT * FROM auction_result WHERE match_id = ${m}`,
      `SELECT * FROM word_play WHERE match_id = ${m}`,
    ]);
}

function endMatch() {
  if (!cur) return;
  const c = cur;
  const parts = [...conn.db.matchParticipant.iter()].filter((p) => p.matchId === c.id);
  parts.sort((a, b) => Number(b.score - a.score));
  const names = parts.map((p) => `${conn.db.bot.id.find(p.botId)?.name ?? p.botId}:${p.score}/${p.balance}`);
  console.log(`[${ts()}] match ${c.id} ENDED  ${names.join(" | ")}`);
  c.log.write(JSON.stringify({ type: "end", variant, me: String(myBotId), names: parts.map((p) => conn.db.bot.id.find(p.botId)?.name ?? String(p.botId)), parts: parts.map((p) => ({ bot: String(p.botId), score: Number(p.score), balance: Number(p.balance) })) }) + "\n");
  c.log.end();
  try {
    c.sub?.unsubscribe();
  } catch {}
  cur = null;
  matchesPlayed++;
  setTimeout(joinLobby, 300);
}

function rackFor(matchId: bigint): Uint8Array {
  const r = new Uint8Array(26);
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    const c = h.letter.charCodeAt(0) - 65;
    if (c >= 0 && c < 26) r[c]! += h.count;
  }
  return r;
}

function buildView(c: MatchCtx, letter: number): View | null {
  const ms = conn.db.matchState.id.find(c.id);
  if (!ms) return null;
  const parts = [...conn.db.matchParticipant.iter()].filter((p) => p.matchId === c.id);
  parts.sort((a, b) => (a.id < b.id ? -1 : 1));
  c.seats = parts.map((p) => p.botId);
  c.mySeat = c.seats.findIndex((b) => b === myBotId);
  if (c.mySeat < 0) return null;
  const seatOf = new Map(c.seats.map((b, i) => [b.toString(), i] as const));
  const results = [...conn.db.auctionResult.iter()].filter((r) => r.matchId === c.id);
  results.sort((a, b) => (a.auctionId < b.auctionId ? -1 : 1));
  const auctions: AuctionRecord[] = results.map((r, i) => ({
    round: i,
    letter: r.letter.charCodeAt(0) - 65,
    winner: r.winnerBotId === undefined || r.winnerBotId === null ? -1 : seatOf.get(r.winnerBotId.toString()) ?? -1,
    paid: Number(r.paid),
    topBid: 0,
  }));
  const wps = [...conn.db.wordPlay.iter()].filter((w) => w.matchId === c.id);
  wps.sort((a, b) => (a.id < b.id ? -1 : 1));
  const words: WordRecord[] = wps.map((w) => ({
    round: 0,
    seat: seatOf.get(w.botId.toString()) ?? -1,
    word: w.word,
    score: Number(w.totalReward),
  }));
  const me = parts[c.mySeat]!;
  const n = parts.length;
  return {
    seat: c.mySeat,
    nPlayers: n,
    round: auctions.length,
    totalAuctions: 98 - ms.startingRackSize * n,
    bagLeft: ms.bagTotal,
    letter,
    rack: rackFor(c.id),
    balance: Number(me.balance),
    score: Number(me.score),
    balances: parts.map((p) => Number(p.balance)),
    scores: parts.map((p) => Number(p.score)),
    auctions,
    words,
    startingRack: ms.startingRackSize,
    auctionType: ms.auctionType.tag === "FirstPrice" ? "FirstPrice" : "Vickrey",
  };
}

function wordValue(w: string): number {
  const VAL = [1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10];
  let b = 0;
  for (const ch of w) b += VAL[ch.charCodeAt(0) - 65]!;
  const n = w.length;
  return n <= 3 ? b : n === 4 ? Math.floor((b * 3) / 2) : n === 5 ? b * 2 : n === 6 ? Math.floor((b * 5) / 2) : b * 3;
}

// Feed completed auctions to the strategy (in order) before it acts.
function feedResults(c: MatchCtx) {
  if (!c.reset) return;
  const v0 = buildView(c, -1);
  if (!v0) return;
  for (const a of v0.auctions) {
    const key = BigInt(a.round);
    if (c.resultsSeen.has(key)) continue;
    c.resultsSeen.add(key);
    strategy.onResult?.(v0, a);
    const myBid = c.bids.get(key);
    c.log.write(JSON.stringify({ type: "result", round: a.round, letter: String.fromCharCode(65 + a.letter), winner: a.winner, me: c.mySeat, paid: a.paid, myBid }) + "\n");
  }
}

function tick() {
  const c = cur;
  if (!c || !c.applied) return;
  const ms = conn.db.matchState.id.find(c.id);
  if (!ms) return;
  if (ms.status.tag !== "Running") {
    if (c.reset || ms.status.tag === "Ended") endMatch();
    return;
  }
  const open = [...conn.db.auction.iter()].find((a) => a.matchId === c.id && a.status.tag === "Open");
  if (!c.reset) {
    const v = buildView(c, -1);
    if (!v) return;
    // A fresh strategy instance state per match.
    strategy.reset?.(c.mySeat, v.nPlayers, { next: Math.random, int: (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1)) } as never);
    c.reset = true;
    // Results that happened before we attached (normally none).
    if (v.auctions.length > 0) console.warn(`[${ts()}] attached late: ${v.auctions.length} auctions already done`);
  }
  feedResults(c);
  if (!open || c.handledAuctions.has(open.id)) return;
  c.handledAuctions.add(open.id);
  const letter = open.letter.charCodeAt(0) - 65;
  const v = buildView(c, letter);
  if (!v) return;
  const t0 = performance.now();
  let act: { words: string[]; bid: number };
  try {
    act = strategy.act(v);
  } catch (e) {
    console.error("strategy error", e);
    act = { words: [], bid: 0 };
  }
  const dt = performance.now() - t0;
  const remainingMs = Number(open.closesAt.microsSinceUnixEpoch / 1000n) - Date.now();
  let balance = v.balance;
  for (const w of act.words) {
    conn.reducers.submitWord({ matchId: c.id, word: w }).catch(fail(`word ${w}`));
    balance += wordValue(w);
  }
  let bid = Math.max(0, Math.min(Math.floor(act.bid), balance));
  c.bids.set(BigInt(v.round), bid);
  if (bid > 0) {
    const auctionId = open.id;
    conn.reducers.submitBid({ auctionId, amount: BigInt(bid) }).catch((e: unknown) => {
      fail(`bid ${bid}`)(e);
      // Retry with what we certainly have (a word may have failed).
      const me = [...conn.db.matchParticipant.iter()].find((p) => p.matchId === c.id && p.botId === myBotId);
      const safe = Math.min(bid, Number(me?.balance ?? 0n));
      if (safe > 0 && safe < bid)
        conn.reducers.submitBid({ auctionId, amount: BigInt(safe) }).catch(fail(`retry bid ${safe}`));
    });
  }
  const rackStr = [...v.rack].map((n, i) => String.fromCharCode(65 + i).repeat(n)).join("");
  console.log(
    `[${ts()}] m${c.id} r${v.round}/${v.totalAuctions} bag=${v.bagLeft} '${open.letter}' rack=${rackStr} bal=${v.balance} -> bid ${bid}${act.words.length ? " words " + act.words.join(",") : ""} (${dt.toFixed(0)}ms, ${remainingMs}ms left)`,
  );
  c.log.write(
    JSON.stringify({ type: "act", round: v.round, letter: open.letter, rack: rackStr, bal: v.balance, balances: v.balances, scores: v.scores, bid, words: act.words, ms: Math.round(dt), left: remainingMs }) + "\n",
  );
}

function onConnect(c: DbConnection, identity: Identity, token: string) {
  conn = c;
  myIdentity = identity;
  fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  console.log(`[bot] connected as ${identity.toHexString()}`);
  const base = () =>
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        myBotId = conn.db.botCredential.identity.find(myIdentity!)?.botId ?? null;
        if (myBotId === null) {
          if (BOT_NONCE) {
            console.log("[bot] claiming credential with nonce");
            conn.reducers.claimCredential({ code: BOT_NONCE }).catch(fail("claim credential"));
            setTimeout(() => {
              myBotId = conn.db.botCredential.identity.find(myIdentity!)?.botId ?? null;
              if (myBotId === null) {
                console.error("[bot] claim failed");
                process.exit(1);
              }
              afterBot();
            }, 1500);
            return;
          }
          console.error("[bot] no bot credential for this token");
          process.exit(1);
        }
        afterBot();
      })
      .subscribe([
        "SELECT * FROM bot",
        "SELECT * FROM bot_credential",
        "SELECT * FROM lobby",
        "SELECT * FROM lobby_member",
        "SELECT * FROM my_rack",
      ]);
  base();

  conn.db.auction.onInsert(() => setImmediate(tick));
  conn.db.auctionResult.onInsert(() => setImmediate(tick));
  conn.db.matchState.onUpdate(() => setImmediate(tick));
  conn.db.myRack.onInsert(() => setImmediate(tick));
}

let participantSub = false;
function afterBot() {
  const bot = conn.db.bot.id.find(myBotId!);
  console.log(`[bot] acting as '${bot?.name}' (id ${myBotId})`);
  if (!participantSub) {
    participantSub = true;
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        // Attach to our latest match; tick() ends it at once if it's over.
        let latest: bigint | null = null;
        for (const p of conn.db.matchParticipant.iter())
          if (p.botId === myBotId && (latest === null || p.matchId > latest)) latest = p.matchId;
        if (latest !== null) startMatch(latest);
        else joinLobby();
      })
      .subscribe([`SELECT * FROM match_participant WHERE bot_id = ${myBotId}`]);
    conn.db.matchParticipant.onInsert((_ctx, p) => {
      if (p.botId === myBotId) setTimeout(() => startMatch(p.matchId), 0);
    });
  }
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() => console.log(`[bot] registered for tournament ${TOURNAMENT_ID}`))
      .catch(fail("tournament registration"));
  }
  // Watch tournaments and register automatically while registration is open.
  conn.subscriptionBuilder().subscribe(["SELECT * FROM tournament", `SELECT * FROM tournament_entry WHERE bot_id = ${myBotId}`]);
  const registered = new Set<string>();
  const autoRegister = () => {
    if (process.env.NO_TOURNAMENT === "1") return;
    for (const t of conn.db.tournament.iter()) {
      if (t.status.tag !== "Registration") continue;
      const id = t.id.toString();
      const already = [...conn.db.tournamentEntry.iter()].some((e) => e.tournamentId === t.id && e.botId === myBotId);
      if (already) {
        if (!registered.has(id)) console.log(`[bot] confirmed registered for tournament ${id}`);
        registered.add(id);
        continue;
      }
      console.log(`[bot] tournament ${id} is open for registration -> registering`);
      conn.reducers.registerForTournament({ tournamentId: t.id }).catch(fail(`register tournament ${id}`));
    }
  };
  // Periodic safety net: rejoin lobby if idle, end stale matches.
  setInterval(() => {
    autoRegister();
    if (cur) tick();
    else joinLobby();
  }, 3000);
}

DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .withToken(BOT_NONCE ? undefined : loadToken())
  .onConnect(onConnect)
  .onConnectError((_ctx: unknown, err: Error) => console.error("connect error:", err.message))
  .onDisconnect(() => {
    console.log("[bot] disconnected; exiting so a supervisor can restart");
    process.exit(2);
  })
  .build();
