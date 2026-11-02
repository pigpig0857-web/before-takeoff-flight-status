"""Independent, offline replay of the raw public schedule; does not change live data."""
import csv
import hashlib
import json
import re
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

root = Path('data/source-samples/crawler/tigerair-research-20261013')
out = root / 'verified-with-timezones'
load = lambda p: json.loads(p.read_text(encoding='utf-8'))
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
first = load(root / 'merged-receipt.json')
repeat = load(root / 'merged-repeat.json.receipt.json')
assert first['status'] == repeat['status'] == 200
assert first['sha256'] == digest(root / 'merged-schedules.json') == repeat['sha256'] == digest(root / 'merged-repeat.json')
raw_zones = root / 'openflights-airports.dat'
assert digest(raw_zones) == load(root / 'openflights-airports.dat.receipt.json')['sha256']
zones = {r[4]: r[11] for r in csv.reader(raw_zones.read_text(encoding='utf-8').splitlines()) if r[4] != '\\N'}
begin, end = date(2026, 10, 13), date(2026, 12, 31)
week = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
oracle = {}
raw_rules = load(root / 'merged-schedules.json')['data']
for country in raw_rules:
    for station in country['stationSchedules']:
        for rule in station['schedules']:
            if rule['origin'] != 'TPE':
                continue
            active_dates, year = set(), None
            for segment in re.split('[,、]', rule['operationDateSummary']):
                ends = segment.strip().split('-')
                dates = []
                for token in ends:
                    fields = token.strip().split('/')
                    if len(fields) == 3:
                        year = int(fields.pop(0))
                    assert len(fields) == 2 and year is not None
                    dates.append(date(year, int(fields[0]), int(fields[1])))
                start, stop = max(begin, dates[0]), min(end, dates[-1])
                for delta in range((stop - start).days + 1):
                    day = start + timedelta(days=delta)
                    if rule['daysOfWeek'][week[day.weekday()]]:
                        active_dates.add(day)
            for day in active_dates:
                dep = datetime.fromisoformat(f"{day.isoformat()}T{rule['departureTime']}").replace(tzinfo=ZoneInfo('Asia/Taipei'))
                arr_day = day + timedelta(days=rule['overnight'])
                arr = datetime.fromisoformat(f"{arr_day.isoformat()}T{rule['arrivalTime']}").replace(tzinfo=ZoneInfo(zones[rule['destination']]))
                dep_iso = dep.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
                arr_iso = arr.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
                assert (arr.astimezone(timezone.utc) - dep.astimezone(timezone.utc)).total_seconds() / 60 == rule['durationInMinutes']
                key = f"{day}|TPE|{rule['destination']}|IT{rule['flightNumber']}"
                assert key not in oracle, key
                oracle[key] = (dep_iso, arr_iso, rule['durationInMinutes'], country['countryCode'])

saved = [f for month in ['2026-10', '2026-11', '2026-12'] for f in load(out / f'flights-{month}.json')['flights']]
assert len(saved) == len({f['id'] for f in saved})
assert set(oracle) == {f['id'] for f in saved}
for flight in saved:
    assert oracle[flight['id']] == (flight['scheduledDeparture'], flight['scheduledArrival'], flight['durationMinutes'], flight['countryCode'])
    assert all(flight[k] is None for k in ['aircraft', 'departureTerminal', 'arrivalTerminal', 'gate', 'counter'])
audit = load(out / 'audit.json')
assert len(saved) == audit['flights'] and audit['pendingRules'] == audit['conflictingFlights'] == 0
pending = load(out / 'pending.json')
assert pending == {'rules': [], 'conflicts': []}
initial = load(root / 'audit-start.json')
current_hashes = {name: digest(Path('src/server/data') / name) for name in initial['beforeHashes']}
assert current_hashes == initial['beforeHashes']
assert digest(Path('src/features/flights/airline-scope.ts')) == initial['scopeHash']
assert len(audit['daily']) == 80 and all(d['flights'] == sum(f['date'] == d['date'] for f in saved) for d in audit['daily'])
summary = {'state': 'passed', 'verifiedAt': datetime.now(timezone.utc).isoformat(),
           'independentReplay': {'method': 'Python date-range enumeration and ZoneInfo from raw OpenFlights data',
                                 'identitiesCompared': len(saved), 'timesAndDurationsCompared': len(saved), 'mismatches': 0},
           'sourceStability': {'observations': 2, 'identical': True, 'sha256': first['sha256']},
           'batches': {m: sum(f['date'].startswith(m) for f in saved) for m in ['2026-10', '2026-11', '2026-12']},
           'destinations': len({f['destination'] for f in saved}), 'countries': dict(Counter(f['countryCode'] for f in saved)),
           'websiteDataUnchanged': True, 'websiteAirlineScopeUnchanged': True,
           'outputHashes': {p.name: digest(p) for p in out.glob('*.json')}}
with (out / 'independent-verification.json').open('x', encoding='utf-8') as handle:
    json.dump(summary, handle, ensure_ascii=False, indent=2)
print(json.dumps({**summary, 'outputHashes': '(saved in report)'}, ensure_ascii=False, indent=2))
