"""Offline completion from preserved public sources; never overwrite baseline."""
import collections
import copy
import datetime as dt
import hashlib
import importlib.util
import json
import pathlib

ROOT = pathlib.Path('data/source-samples/crawler/jta-jetstar-completeness-20261014')
BASE = pathlib.Path('data/source-samples/crawler/new-airlines-20261014')
spec = importlib.util.spec_from_file_location('kix', pathlib.Path(__file__).with_name('parse-kix-schedule-evidence.py'))
kix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kix)

def read(file):
    return json.loads(file.read_text(encoding='utf-8-sig'))

def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

def save(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    if file.exists():
        assert read(file) == value, f'Refusing to replace a differing saved result: {file}'
    else:
        file.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

def key(r):
    return r['date'], r['number'], r['airport']

progress = read(ROOT / 'kix-daily/progress.json')
assert progress['state'] == 'completed' and len(progress['completed']) == 79
airport_rows = []
for query in progress['completed']:
    file = ROOT / query['file']
    assert sha(file) == query['sha256']
    rows = kix.parse_saved(file, query['date'])
    assert {r['number'] for r in rows} == {'GK50', 'GK54'}, query['date']
    airport_rows.extend(rows)
assert len(airport_rows) == len({key(r) for r in airport_rows}) == 158
airport_by_key = {key(r): r for r in airport_rows}
baseline = read(BASE / 'verified-jetstar/candidate-flights.json')
jetstar = copy.deepcopy(baseline)
compared = []
conflicts = []
for row in baseline['records']:
    if row['airport'] != 'KIX':
        continue
    evidence_row = airport_by_key[key(row)]
    differences = {field: [row[field], evidence_row[field]] for field in ['departure', 'arrival', 'minutes'] if row[field] != evidence_row[field]}
    compared.append({'date': row['date'], 'number': row['number'], 'differences': differences})
    if differences:
        conflicts.append(compared[-1])
save(ROOT / 'kix-comparison.json', {'compared': len(compared), 'conflicts': conflicts, 'rows': compared})
assert not conflicts, 'Source conflict requires review before completion or import'
resolved = []
template = next(r for r in baseline['records'] if r['number'] == 'GK50')
for pending in read(BASE / 'verified-jetstar/pending.json'):
    verified = airport_by_key[key(pending)]
    row = copy.deepcopy(template)
    for field in ['date', 'departure', 'arrival', 'minutes', 'fetchedAt', 'evidence']:
        row[field] = verified[field]
    row.update(kind='collected_kix', label='關西機場公開預定班表（OAG）',
               url='https://www.kansai-airport.or.jp/tw/flight/schedule', sourcePublishedAt=None,
               sourceNotice='關西機場公開班表由 OAG 提供，非捷星自有班表；預定安排可能異動，非可售庫存或即時動態。')
    # Terminals were separately published in the Jetstar PDF route header.
    row['terminalEvidence'] = copy.deepcopy(template['evidence'])
    row['terminalEvidence']['basis'] = 'published_timetable_route_header'
    jetstar['records'].append(row)
    resolved.append({'date': row['date'], 'number': row['number'], 'state': 'confirmed_in_airport_schedule', 'evidence': verified['evidence']})
jetstar['records'].sort(key=lambda r: (r['date'], r['departure'], r['number']))
assert len(resolved) == 61 and len(jetstar['records']) == 320

jta = read(BASE / 'verified-jta/candidate-flights.json')
guide_file = ROOT / 'jta-tpe-terminal-guide.json'
guide = read(guide_file)
assert guide['terminal'] == 'T2' and '日本トランスオーシャン航空' in guide['sourceText']
assert guide['method'] == 'ordinary_browser_public_dom' and guide['authenticated'] is False
for row in jta['records']:
    row['terminal'] = 'T2'
    row['terminalEvidence'] = {'file': str(guide_file), 'sha256': sha(guide_file),
                               'sourceUrl': guide['sourceUrl'], 'fetchedAt': guide['capturedAt'],
                               'basis': 'published_airline_airport_guide', 'publishedAt': guide['publishedAt']}

for brand, pack in [('jta', jta), ('jetstar', jetstar)]:
    root = ROOT / f'verified-{brand}'
    rows = pack['records']
    assert len(rows) == len({key(r) for r in rows})
    for row in rows:
        for field in ['number', 'airline', 'date', 'departure', 'arrival', 'arrivalTimeZone', 'origin', 'airport', 'countryCode', 'url', 'fetchedAt', 'evidence']:
            assert row[field], (key(row), field)
        assert row['origin'] == 'TPE' and '2026-10-14' <= row['date'] <= '2026-12-31'
        assert (dt.datetime.fromisoformat(row['arrival']) - dt.datetime.fromisoformat(row['departure'])).total_seconds() == row['minutes'] * 60
        assert sha(pathlib.Path(row['evidence']['file'])) == row['evidence']['sha256']
        assert row['gate'] is None and row['counter'] is None
    save(root / 'candidate-flights.json', pack)
    checkpoints = []
    for month in ['2026-10', '2026-11', '2026-12']:
        file = root / f'flights-{month}.json'
        subset = [r for r in rows if r['date'].startswith(month)]
        save(file, {'scope': pack['scope'], 'records': subset})
        checkpoints.append({'month': month, 'file': file.name, 'records': len(subset), 'sha256': sha(file)})
    save(root / 'checkpoint.json', {'state': 'core_verified', 'records': len(rows), 'batches': checkpoints, 'integratedIntoWebsite': False})
    save(root / 'pending.json', [])
    audit = {'state': 'core_verified', 'scope': pack['scope'], 'records': len(rows),
             'duplicates': 0, 'missingNecessaryFields': 0, 'sourceHashesVerified': True,
             'timezonesAndDurationsVerified': True, 'pendingDateFlightChecks': 0,
             'sourceConflicts': 0, 'byMonth': dict(collections.Counter(r['date'][:7] for r in rows)),
             'byAirport': dict(collections.Counter(r['airport'] for r in rows)),
             'byFlightNumber': dict(collections.Counter(r['number'] for r in rows)),
             'bySource': dict(collections.Counter(r['kind'] for r in rows)),
             'dateCoverage': len({r['date'] for r in rows}),
             'publishedDepartureTerminal': sum(bool(r['terminal']) for r in rows),
             'publishedArrivalTerminal': sum(bool(r['arrivalTerminal']) for r in rows),
             'publishedAircraft': sum(bool(r['aircraft']) for r in rows),
             'notRealtime': True, 'notBookingInventory': True,
             'wholeAirlineInventoryVerified': False,
             'longTermAutomaticReliabilityProven': False, 'integratedIntoWebsite': False}
    if brand == 'jetstar':
        audit.update(airportDailyQueriesVerified=79, airportRowsVerified=158, matchingPdfRows=97, sourceGapsResolved=61)
        save(root / 'resolved.json', resolved)
    save(root / 'audit.json', audit)
    print(json.dumps(audit, ensure_ascii=False))

originals = read(BASE / 'existing-website-data-check.json')['files']
for name, check in originals.items():
    assert sha(pathlib.Path('src/server/data') / name) == check['sha256'], name
save(ROOT / 'website-data-check.json', {'state': 'passed', 'files': originals, 'modifiedWebsite': False})
