"""Replay official Jetstar PDF rules, retaining gaps rather than inventing flights."""
import collections
import datetime as dt
import hashlib
import json
import pathlib
import re
from zoneinfo import ZoneInfo
from pypdf import PdfReader

ROOT = pathlib.Path('data/source-samples/crawler/new-airlines-20261014')
OUT = ROOT / 'verified-jetstar'
START, END = dt.date(2026, 10, 14), dt.date(2026, 12, 31)

def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        assert read(path) == value, f'Saved result differs: {path}'
    else:
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')

rules, records = [], []
pattern = re.compile(r'(GK(?:12|14|16|50|54))\s+(\d{2}:\d{2})\s+(\d{2}:\d{2})\s+(Daily|[.1-7]{7})\s+(\d{1,2}/\d{1,2}(?:-\d{1,2}/\d{1,2})?)')
for season, period, published in [('summer', ('2026-03-29', '2026-10-24'), '2026-02-03'), ('winter', ('2026-10-25', '2027-03-27'), '2026-09-09')]:
    stem = f'jetstar-{season}-pdf'
    body = ROOT / f'{stem}.body'
    receipt = read(ROOT / f'{stem}.receipt.json')
    assert receipt['status'] == 200 and receipt['sha256'] == digest(body)
    assert receipt['url'] == f'https://files.jetstar.com/api/public/content/gk_jq_timetable_26n{"s" if season == "summer" else "w"}int'
    pdf = PdfReader(body)
    assert len(pdf.pages) == 1
    text = pdf.pages[0].extract_text(extraction_mode='layout')
    assert text == (ROOT / f'{stem}-page1.txt').read_text(encoding='utf-8')
    compact = re.sub(r'\s+', '', text)
    assert ('2026/3/29-2026/10/24' if season == 'summer' else '2026/10/25-2027/3/27') in compact
    assert ('2026年2月03日' if season == 'summer' else '2026年9月9日') in compact
    assert 'TaipeiTaoyuan(TPE)' in compact and '第1ターミナルT1' in compact and '第3ターミナルT3' in compact
    for line_index, line in enumerate(text.splitlines(), 1):
        match = pattern.search(line)
        if not match:
            continue
        number, departure_clock, arrival_clock, days, source_period = match.groups()
        airport = 'NRT' if number in ['GK12', 'GK14', 'GK16'] else 'KIX'
        dates = source_period.split('-')
        def as_date(value):
            month, day = map(int, value.split('/'))
            return dt.date(2027 if season == 'winter' and month < 10 else 2026, month, day)
        first, last = as_date(dates[0]), as_date(dates[-1])
        assert dt.date.fromisoformat(period[0]) <= first <= last <= dt.date.fromisoformat(period[1])
        rule = {'number': number, 'airport': airport, 'departure': departure_clock, 'arrival': arrival_clock,
                'days': days, 'first': str(first), 'last': str(last), 'season': season, 'line': line_index, 'sourceLine': line}
        rules.append(rule)
        day = max(START, first)
        while day <= min(END, last):
            if days == 'Daily' or str(day.isoweekday()) in days:
                departure = dt.datetime.fromisoformat(f'{day}T{departure_clock}:00').replace(tzinfo=ZoneInfo('Asia/Taipei'))
                arrival = dt.datetime.fromisoformat(f'{day}T{arrival_clock}:00').replace(tzinfo=ZoneInfo('Asia/Tokyo'))
                minutes = int((arrival - departure).total_seconds() // 60)
                assert 90 <= minutes <= 240
                records.append({'number': number, 'airline': '捷星日本航空', 'airlineCode': 'GK', 'date': str(day),
                    'departure': departure.isoformat(), 'arrival': arrival.isoformat(), 'arrivalTimeZone': 'Asia/Tokyo',
                    'origin': 'TPE', 'airport': airport, 'destination': '東京' if airport == 'NRT' else '大阪',
                    'destinationEnglish': 'Tokyo' if airport == 'NRT' else 'Osaka', 'countryCode': 'JP',
                    'terminal': 'T1', 'arrivalTerminal': '3' if airport == 'NRT' else '1',
                    'aircraft': None, 'gate': None, 'counter': None, 'minutes': minutes, 'kind': 'collected_jetstar',
                    'label': '捷星日本航空官方預定班表', 'url': receipt['url'], 'fetchedAt': receipt['fetchedAt'],
                    'sourcePublishedAt': published, 'operatingAirline': '捷星日本航空', 'operatingNumber': None, 'codeshare': False,
                    'evidence': {'file': str(body), 'sha256': digest(body), 'sourceUrl': receipt['url'], 'page': 1,
                                 'lineIndex': line_index, 'sourceLine': line, 'period': source_period, 'recurrence': days},
                    'sourceNotice': '官方公布的預定班表，安排可能異動；官方通用註記表示計畫以相關主管機關核准為前提。'})
            day += dt.timedelta(days=1)

assert len(rules) == 15
records.sort(key=lambda r: (r['date'], r['departure'], r['number']))
identities = [(r['date'], r['number'], r['airport'], r['departure']) for r in records]
assert len(records) == len(set(identities)) == 259
by_month = dict(collections.Counter(r['date'][:7] for r in records))
assert by_month == {'2026-10': 66, '2026-11': 90, '2026-12': 103}
assert dict(collections.Counter(r['airport'] for r in records)) == {'KIX': 97, 'NRT': 162}
assert not any(r['number'] == 'GK50' and '2026-10-26' <= r['date'] <= '2026-12-25' for r in records)
assert [(r['date'], r['departure'][11:16]) for r in records if r['number'] == 'GK16'] == [
    ('2026-12-26', '16:45'), ('2026-12-28', '16:45'), ('2026-12-29', '16:50'), ('2026-12-31', '16:45')]
pending = []
day = dt.date(2026, 10, 26)
while day <= dt.date(2026, 12, 25):
    pending.append({'number': 'GK50', 'date': str(day), 'origin': 'TPE', 'airport': 'KIX', 'state': 'source_period_gap_pending_confirmation',
                    'reason': 'Official winter PDF explicitly lists 10/25 and 12/26 onward. No schedule row covers this date; no conclusion that the flight is cancelled or not operating.'})
    day += dt.timedelta(days=1)
assert len(pending) == 61
save(OUT / 'source-rules.json', rules)
for month in by_month:
    save(OUT / f'flights-{month}.json', {'records': [r for r in records if r['date'].startswith(month)]})
save(OUT / 'candidate-flights.json', {'scope': {'origin': 'TPE', 'from': str(START), 'through': str(END), 'inclusive': True}, 'records': records})
save(OUT / 'pending.json', pending)
save(OUT / 'checkpoint.json', {'state': 'verified_published_rows_with_source_gap', 'byMonth': [
    {'month': month, 'count': by_month[month], 'file': f'flights-{month}.json', 'sha256': digest(OUT / f'flights-{month}.json')} for month in by_month]})
audit = {'state': 'verified_published_rows_with_source_gap', 'records': len(records), 'duplicates': 0, 'conflicts': 0,
         'byMonth': by_month, 'byAirport': dict(collections.Counter(r['airport'] for r in records)),
         'byFlightNumber': dict(collections.Counter(r['number'] for r in records)), 'sourceRules': len(rules),
         'dateCoverage': 79, 'necessaryFieldsComplete': 259, 'departureTerminal': 259, 'arrivalTerminal': 259, 'aircraft': 0,
         'pendingDateFlightChecks': 61, 'sourceHashesVerified': True, 'timezonesAndDurationsVerified': True,
         'wholeAirlineInventoryVerified': False, 'notBookingInventory': True, 'notRealtime': True,
         'integratedIntoWebsite': False, 'longTermAutomaticReliabilityProven': False,
         'scope': {'origin': 'TPE', 'from': str(START), 'through': str(END), 'inclusive': True}}
save(OUT / 'audit.json', audit)
print(json.dumps(audit, ensure_ascii=False))
