"""Normalize saved public JTA timetable rules; no network or website import."""
import collections
import datetime as dt
import hashlib
import json
import pathlib
import re
import unicodedata
from zoneinfo import ZoneInfo

ROOT = pathlib.Path('data/source-samples/crawler/new-airlines-20261014')
OUT = ROOT / 'verified-jta'
START, END = dt.date(2026, 10, 14), dt.date(2026, 12, 31)

def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(value, ensure_ascii=False, indent=2)
    if path.exists():
        assert read(path) == value, f'Saved result differs: {path}'
    else:
        path.write_text(text, encoding='utf-8')

source_path = ROOT / 'jta-browser-schedule.json'
source = read(source_path)
assert source['sourceUrl'] == 'https://www.jal.co.jp/tw/en/offers/okinawa-jta/'
assert source['method'] == 'ordinary_browser_public_dom' and source['authenticated'] is False
assert source['periodHeadings'] == ['March 29 – October 24, 2026', 'October 25, 2026 – March 27,2027']
assert len(source['tables']) == 2
support = []
for stem, date in [('jta-summer-plan-pdf', '2026-02-05'), ('jta-winter-sale-pdf', '2026-07-16'), ('jta-winter-increase-pdf', '2026-08-18')]:
    body = ROOT / f'{stem}.body'
    receipt = read(ROOT / f'{stem}.receipt.json')
    assert receipt['status'] == 200 and receipt['sha256'] == digest(body)
    assert receipt['url'].startswith('https://jta-okinawa.com/cms/wp-content/uploads/')
    support.append({'file': str(body), 'sha256': receipt['sha256'], 'sourceUrl': receipt['url'], 'publishedAt': date})

# Validate the published cells before interpreting any recurrence or footnote.
expected = [('NU302', '10:05', '12:40'), ('NU308', '19:40', '22:20'), ('NU302', '10:15', '12:50'), ('NU308', '19:40', '22:15')]
rules = []
for table_index, table in enumerate(source['tables']):
    for row_index, row in enumerate(table['rows'][1:], 1):
        if row[0] not in ['NU302', 'NU308']:
            continue
        assert len(row) == 6 and row[1] == 'From Taipei (Taoyuan) To Okinawa (Naha)'
        assert row[5] == 'Boeing 737-800'
        departure = row[2].strip()
        arrival = re.match(r'^\d{2}:\d{2}', row[3]).group()
        assert (row[0], departure, arrival) == expected[len(rules)]
        assert row[4] == ('September 24,25,27,28 / October 9,11,12,24' if table_index == 0 and row[0] == 'NU308' else 'Daily')
        if table_index == 1:
            assert 'advanced by 5 minutes from December 1 to February 28' in row[3]
        if table_index == 0 and row[0] == 'NU308':
            assert 'In October, arrivals are advanced by 5 minutes' in row[3]
        rules.append({'number': row[0], 'tableIndex': table_index, 'rowIndex': row_index, 'departure': departure, 'arrival': arrival, 'cells': row})

records = []
day = START
while day <= END:
    table_index = int(day >= dt.date(2026, 10, 25))
    for rule in [r for r in rules if r['tableIndex'] == table_index]:
        if table_index == 0 and rule['number'] == 'NU308' and day != dt.date(2026, 10, 24):
            continue
        departure = dt.datetime.fromisoformat(f'{day}T{rule["departure"]}:00').replace(tzinfo=ZoneInfo('Asia/Taipei'))
        arrival = dt.datetime.fromisoformat(f'{day}T{rule["arrival"]}:00').replace(tzinfo=ZoneInfo('Asia/Tokyo'))
        adjustment = -5 if (table_index == 1 and day.month == 12) or (table_index == 0 and rule['number'] == 'NU308') else 0
        arrival += dt.timedelta(minutes=adjustment)
        minutes = int((arrival - departure).total_seconds() // 60)
        assert minutes in [90, 95]
        assert departure.utcoffset() == dt.timedelta(hours=8) and arrival.utcoffset() == dt.timedelta(hours=9)
        records.append({
            'number': rule['number'], 'airline': '日本越洋航空', 'airlineCode': 'NU', 'date': day.isoformat(),
            'departure': departure.isoformat(), 'arrival': arrival.isoformat(), 'arrivalTimeZone': 'Asia/Tokyo',
            'origin': 'TPE', 'airport': 'OKA', 'destination': '沖繩', 'destinationEnglish': 'Okinawa', 'countryCode': 'JP',
            'terminal': None, 'arrivalTerminal': None, 'gate': None, 'counter': None,
            'aircraft': rule['cells'][5], 'minutes': minutes, 'kind': 'collected_jta',
            'label': '日本越洋航空官方預定班表', 'url': source['sourceUrl'], 'fetchedAt': source['capturedAt'],
            'sourcePublishedAt': None, 'operatingAirline': '日本越洋航空', 'operatingNumber': None, 'codeshare': False,
            'evidence': {'file': str(source_path), 'sha256': digest(source_path), 'sourceUrl': source['sourceUrl'],
                         'method': source['method'], 'tableIndex': rule['tableIndex'], 'rowIndex': rule['rowIndex'],
                         'recurrence': rule['cells'][4], 'arrivalAdjustmentMinutes': adjustment, 'supportingPdfs': support},
            'sourceNotice': '官方公布的預定班表，安排可能異動；官方通用註記表示計畫以相關主管機關核准為前提。',
        })
    day += dt.timedelta(days=1)

identities = [(r['date'], r['number'], r['airport'], r['departure']) for r in records]
assert len(set(identities)) == len(records) == 148
counts = dict(collections.Counter(r['date'][:7] for r in records))
assert counts == {'2026-10': 26, '2026-11': 60, '2026-12': 62}
assert len({r['date'] for r in records}) == 79
def at(date, number):
    return next(r for r in records if r['date'] == date and r['number'] == number)
assert not any(r['number'] == 'NU308' and r['date'] == '2026-10-23' for r in records)
assert at('2026-10-24', 'NU308')['arrival'] == '2026-10-24T22:15:00+09:00'
assert at('2026-10-25', 'NU302')['departure'] == '2026-10-25T10:15:00+08:00'
assert at('2026-11-30', 'NU308')['arrival'] == '2026-11-30T22:15:00+09:00'
assert at('2026-12-01', 'NU302')['arrival'] == '2026-12-01T12:45:00+09:00'
assert at('2026-12-31', 'NU308')['arrival'] == '2026-12-31T22:10:00+09:00'
for month in counts:
    save(OUT / f'flights-{month}.json', {'records': [r for r in records if r['date'].startswith(month)]})
save(OUT / 'candidate-flights.json', {'scope': {'origin': 'TPE', 'from': str(START), 'through': str(END), 'inclusive': True}, 'records': records})
checkpoint = [{'month': month, 'count': counts[month], 'file': f'flights-{month}.json', 'sha256': digest(OUT / f'flights-{month}.json')} for month in counts]
save(OUT / 'checkpoint.json', {'state': 'verified_for_later_integration', 'byMonth': checkpoint})
save(OUT / 'pending.json', [])
audit = {'state': 'verified', 'records': len(records), 'duplicates': 0, 'conflicts': 0, 'dateCoverage': 79,
         'byMonth': counts, 'byAirport': {'OKA': 148}, 'byFlightNumber': dict(collections.Counter(r['number'] for r in records)),
         'necessaryFieldsComplete': 148, 'aircraft': 148, 'departureTerminal': 0, 'arrivalTerminal': 0,
         'sourceHashesVerified': True, 'timezonesAndDurationsVerified': True, 'explicitScheduleRulesUsed': True,
         'notBookingInventory': True, 'notRealtime': True, 'integratedIntoWebsite': False,
         'longTermAutomaticReliabilityProven': False, 'requiresOrdinaryBrowserForLatestDetailedSchedule': True,
         'scope': {'origin': 'TPE', 'from': str(START), 'through': str(END), 'inclusive': True}}
save(OUT / 'audit.json', audit)
print(json.dumps(audit, ensure_ascii=False))
