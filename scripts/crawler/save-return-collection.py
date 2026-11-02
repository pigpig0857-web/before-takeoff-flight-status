"""Save a deduplicated, audited staging batch. Never writes website data."""
import hashlib
import json
from collections import Counter
from pathlib import Path

root = Path('data/source-samples/crawler/return-expansion-20261019')
peach = Path('data/source-samples/crawler/peach-return-20261019-network/return-candidates-all')
load = lambda p: json.loads(p.read_text(encoding='utf8'))
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
assert load(peach/'independent-audit.json')['status'] == 'passed'
assert load(root/'tigerair-returns/independent-audit.json')['status'] == 'passed'
files = [peach/'flights.json'] + [root/f'tigerair-returns/flights-2026-{month}.json' for month in ('10','11','12')]
records, keys = [], set()
for file in files:
    for record in load(file)['records']:
        key = (record['date'],record['airlineCode'],record['number'],record['departureAirport'],record['arrivalAirport'])
        assert key not in keys, f'Duplicate staged flight {key}'
        keys.add(key)
        records.append(record)
records.sort(key=lambda r:(r['date'],r['departure'],r['airlineCode'],r['number']))
assert len(records) == 2967
before = load(root/'website-before.json')
assert all(digest(Path('src/server/data')/name) == sha for name,sha in before.items())
pending = load(root/'tigerair-returns/pending.json')
assert len(pending['rules']) == 1 and not pending['conflicts']
out = root/'staging'
out.mkdir(exist_ok=False)
for month in ('2026-10','2026-11','2026-12'):
    selected = [r for r in records if r['date'].startswith(month)]
    file = out/f'flights-{month}.json'
    file.write_text(json.dumps(dict(records=selected,integratedIntoWebsite=False),ensure_ascii=False,indent=2),encoding='utf8')
    (out/f'checkpoint-{month}.json').write_text(json.dumps(dict(records=len(selected),sha256=digest(file)),indent=2),encoding='utf8')
summary = dict(status='saved_for_later_import',requestedFrom='2026-10-19',requestedTo='2026-12-31',
               dateBasis='departure local date at overseas origin',records=len(records),
               previouslyCollectedTokyo=293,newUniqueRecordsThisBatch=len(records)-293,
               byAirline=dict(Counter(r['airlineCode'] for r in records)),
               returnAirports=dict(Counter(r['arrivalAirport'] for r in records)),
               departureAirports=len({r['departureAirport'] for r in records}),
               airlineRoutes=len({(r['airlineCode'],r['departureAirport'],r['arrivalAirport']) for r in records}),
               duplicateIdentities=0,pendingRules=1,pendingAffectedDates=['2026-10-22'],
               websiteDataUnchanged=True,integratedIntoWebsite=False,
               sourceFiles=[dict(path=str(file),sha256=digest(file)) for file in files],
               nextSteps=['Other existing airlines inbound source feasibility','Round-trip search implementation and integration tests before website import'])
(out/'progress.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf8')
(out/'pending.json').write_text(json.dumps(pending,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps({k:v for k,v in summary.items() if k != 'sourceFiles'},ensure_ascii=False,indent=2))
