#!/usr/bin/env python3
"""Summarise the live bot's matches from bot/logs/match-*.jsonl."""
import glob, json, os, statistics as st, sys
d = os.path.join(os.path.dirname(__file__), "..", "bot", "logs")
since = int(sys.argv[1]) if len(sys.argv) > 1 else 0
rows = []
for f in sorted(glob.glob(os.path.join(d, "match-*.jsonl"))):
    mid = int(f.split("-")[-1].split(".")[0])
    if mid < since: continue
    acts, res, end = {}, {}, None
    for l in open(f):
        o = json.loads(l)
        if o["type"] == "act": acts[o["round"]] = o
        elif o["type"] == "result": res[o["round"]] = o
        elif o["type"] == "end": end = o
    if not end or not res: continue
    me = next(iter(res.values()))["me"]
    won = [r for r in res.values() if r["winner"] == me]
    parts = end["parts"]
    scores = sorted([p["score"] for p in parts], reverse=True)
    my = max(acts.values(), key=lambda a: a["round"])["scores"][me] if acts else 0
    # final score from end record: match by order isn't guaranteed; use scores list in last act + words
    rows.append((mid, len(parts), scores, won, acts))
tot = {"n": 0, "win": 0, "rank": 0, "score": 0}
byv = {}
for mid, n, scores, won, acts in rows:
    f = os.path.join(d, f"match-{mid}.jsonl")
    end = max([json.loads(l) for l in open(f) if '"end"' in l], key=lambda e: len(e["parts"]))
    mine = next((p for p in end["parts"] if p["bot"] == end.get("me")), None)
    if mine is None or len(end["parts"]) < 2: continue
    rank = sum(1 for p in end["parts"] if p["score"] > mine["score"])
    tot["n"] += 1; tot["win"] += rank == 0; tot["rank"] += rank; tot["score"] += mine["score"]
    v = end.get("variant", "-"); e = byv.setdefault(v, [0, 0, 0, 0]); e[0] += 1; e[1] += rank == 0; e[2] += rank; e[3] += mine["score"]
    print(f"match {mid} n={n} rank={rank+1} me={mine['score']} bal={mine['balance']} best_other={max(p['score'] for p in end['parts'] if p is not mine)} won={len(won)} paid/t={st.mean([w['paid'] for w in won]) if won else 0:.1f} maxms={max(a['ms'] for a in acts.values())} minleft={min(a['left'] for a in acts.values())}")
for v, (n, w, r, sc) in sorted(byv.items()):
    print(f"variant {v}: n={n} winrate={w/n:.0%} avgrank={1+r/n:.2f} avgscore={sc/n:.1f}")
if tot["n"]:
    print(f"TOTAL n={tot['n']} winrate={tot['win']/tot['n']:.0%} avgrank={1+tot['rank']/tot['n']:.2f} avgscore={tot['score']/tot['n']:.1f}")
