import pickle, collections, statistics as st
d = pickle.load(open('hist2.pkl','rb'))
bots=d['bots']
tb = {t['auction_id']: t['top_bid'] for t in d['tb']}
ended = {m['id'] for m in d['ms'] if isinstance(m['status'], list) and m['status'] and m['status'][0]==2}
arm = collections.defaultdict(list)
for a in d['ar']:
    if a['match_id'] in ended: arm[a['match_id']].append(a)
for m in arm: arm[m].sort(key=lambda a:a['auction_id'])
mp = collections.defaultdict(dict)
for p in d['mp']:
    if p['match_id'] in ended: mp[p['match_id']][p['bot_id']] = p
wp = collections.defaultdict(list)
for w in d['wp']:
    if w['match_id'] in ended: wp[w['match_id']].append(w)
