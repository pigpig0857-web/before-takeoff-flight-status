"""Independently replay explicit official dates/times without the TS parser."""
import csv
import hashlib
import json
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

root = Path('data/source-samples/crawler/additional-airlines-20261013')
store, out = root / 'starlux-centered', root / 'verified-starlux'
load = lambda p: json.loads(p.read_text(encoding='utf-8'))
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
plan = load(store / 'plan.json')
airports = {a['code']: a['countryCode'] for a in load(Path('src/features/flights/data/airport-directory.json'))}
raw_zones = Path('data/source-samples/crawler/tigerair-research-20261013/openflights-airports.dat')
assert digest(raw_zones) == load(Path(str(raw_zones)+'.receipt.json'))['sha256']
zones = {r[4]: r[11] for r in csv.reader(raw_zones.read_text(encoding='utf-8').splitlines()) if r[4] != '\\N'}
oracle, covered = {}, set()
for query in plan['requests']:
    key = f"{query['destination']}-{query['week']}"
    raw = store / f'{key}.json'
    receipt = load(store / f'{key}.receipt.json')
    assert receipt['status'] == 200 and receipt['sha256'] == digest(raw)
    response = load(raw)
    assert response['success'] is True and response['message']['code'] == '00000'
    selected = date.fromisoformat(query['date'])
    for offset in range(-3,4):
        d = (selected+timedelta(days=offset)).isoformat()
        if plan['from'] <= d <= plan['through']:
            covered.add((d,query['destination']))
    for row_index, row in enumerate(response['data']['timetable']):
        assert row['depAirport'] == 'TPE' and row['arrAirport'] == query['destination']
        if row['stops'] or row['operatingAirlineCode'] != 'JX':
            continue
        for d in row['schedule']:
            departure_day = date.fromisoformat(d)
            assert -3 <= (departure_day-selected).days <= 3
            if not (plan['from'] <= d <= plan['through']) or d in row['cargoOnly']:
                continue
            dep = datetime.fromisoformat(f"{d}T{row['depTime']}").replace(tzinfo=ZoneInfo('Asia/Taipei'))
            arrival_day = departure_day+timedelta(days=row['arrivalDaysDifference'])
            arr = datetime.fromisoformat(f"{arrival_day}T{row['arrTime']}").replace(tzinfo=ZoneInfo(zones[row['arrAirport']]))
            assert (arr.astimezone(timezone.utc)-dep.astimezone(timezone.utc)).total_seconds()/60 == row['duration']
            iso = lambda dt: dt.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
            number = f"JX{int(row['flightNo'][2:])}"
            ident = f"{d}|TPE|{row['arrAirport']}|{number}"
            assert ident not in oracle
            clean = lambda text: text.strip() or None if text is not None else None
            oracle[ident] = {'scheduledDeparture':iso(dep),'scheduledArrival':iso(arr),'durationMinutes':row['duration'],
                'countryCode':airports[row['arrAirport']],'aircraft':clean(row['aircraftModel']),
                'departureTerminal':clean(row['depTerminal']),'arrivalTerminal':clean(row['arrTerminal']),
                'approvalPending':d in row['pendingApproval'],'sourceRow':row_index}

saved = [f for month in ['2026-10','2026-11','2026-12'] for f in load(out / f'flights-{month}.json')['flights']]
assert len(saved) == len({f['id'] for f in saved}) == len(oracle)
assert set(oracle) == {f['id'] for f in saved}
for flight in saved:
    assert oracle[flight['id']] == {k:flight[k] for k in oracle[flight['id']]}
    assert flight['gate'] is None and flight['counter'] is None
audit = load(out / 'audit.json')
assert audit['pendingRows'] == audit['conflictingIdentities'] == 0
assert len(covered) == audit['coverage']['observed'] == 2640
assert not audit['coverage']['missingCells']
for name, expected in plan['protectedHashes'].items():
    assert digest(Path('src/server/data')/name) == expected
assert digest(Path('src/features/flights/airline-scope.ts')) == plan['scopeHash']
tiger = Path('data/source-samples/crawler/tigerair-research-20261013/verified-with-timezones')
for name, expected in load(tiger/'independent-verification.json')['outputHashes'].items():
    assert digest(tiger/name) == expected
result = {'state':'passed','verifiedAt':datetime.now(timezone.utc).isoformat(),
    'method':'Independent Python replay of explicit dates and ZoneInfo from preserved public airport data',
    'flightsCompared':len(saved),'mismatches':0,'queryDateAirportCells':len(covered),
    'websiteDataUnchanged':True,'tigerairVerifiedSnapshotUnchanged':True,
    'byMonth':dict(Counter(f['date'][:7] for f in saved)),
    'outputHashes':{p.name:digest(p) for p in out.glob('*.json')}}
with (out/'independent-verification.json').open('x',encoding='utf-8') as handle:
    json.dump(result,handle,ensure_ascii=False,indent=2)
print(json.dumps({**result,'outputHashes':'saved in report'},ensure_ascii=False,indent=2))
