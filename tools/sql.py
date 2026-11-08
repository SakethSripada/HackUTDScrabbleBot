#!/usr/bin/env python3
"""Tiny helper to query the public scrabblebot SpacetimeDB via the HTTP SQL API."""
import json, os, sys, urllib.request
HOST = "https://maincloud.spacetimedb.com"
TOKF = os.path.join(os.path.dirname(__file__), ".anon.tok")

def token():
    if os.path.exists(TOKF):
        return open(TOKF).read().strip()
    r = urllib.request.urlopen(urllib.request.Request(HOST + "/v1/identity", method="POST"))
    t = json.load(r)["token"]
    open(TOKF, "w").write(t)
    return t

def unwrap(v):
    # Option / timestamp encodings
    if isinstance(v, list) and len(v) == 2 and isinstance(v[0], int) and v[0] in (0, 1):
        inner = v[1]
        if v[0] == 1 and inner == []:
            return None
        if isinstance(inner, list) and len(inner) == 1:
            return inner[0]
        return inner
    return v

def query(q):
    req = urllib.request.Request(HOST + "/v1/database/scrabblebot/sql", data=q.encode(),
                                 headers={"Authorization": "Bearer " + token()}, method="POST")
    res = json.load(urllib.request.urlopen(req, timeout=120))
    out = []
    for stmt in res:
        names = [e["name"]["some"] for e in stmt["schema"]["elements"]]
        for row in stmt["rows"]:
            out.append({n: unwrap(v) for n, v in zip(names, row)})
    return out

if __name__ == "__main__":
    rows = query(sys.argv[1])
    for r in rows:
        print(json.dumps(r))
