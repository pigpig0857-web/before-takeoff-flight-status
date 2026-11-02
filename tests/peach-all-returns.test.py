"""Independent daily expectations transcribed from reviewed PDF tables."""
import hashlib
import json
from datetime import date, datetime, timedelta
from pathlib import Path

root = Path('data/source-samples/crawler/peach-return-20261019-network')
out = root/'return-candidates-all'
load = lambda p: json.loads(p.read_text(encoding='utf8'))
all_rows = load(out/'flights.json')['records']
previous = load(root/'return-candidates-v2/flights.json')['records']
key = lambda r: (r['date'],r['departureAirport'],r['arrivalAirport'],r['number'],r['departure'],r['arrival'])
old = {key(r) for r in previous}
assert {key(r) for r in all_rows if r['departureAirport'] in ('NRT','HND')} == old
extra = [r for r in all_rows if r['departureAirport'] not in ('NRT','HND')]
expected = set()
for offset in range(74):
    day = date(2026,10,19)+timedelta(days=offset)
    if day <= date(2026,10,24):
        items = [('KIX','TPE','MM23','07:50','09:55'),('KIX','TPE','MM25','10:40','12:45'),
                 ('KIX','TPE','MM27','15:15','17:30'),('KIX','KHH','MM31','10:45','13:10'),
                 ('NGO','TPE','MM723','22:45','00:55'),('OKA','TPE','MM921','08:10','08:45'),
                 ('OKA','TPE','MM929','16:45','17:20')]
        if day.day <= 21:
            items.append(('OKA','TPE','MM6927','13:25','14:00'))
        elif day.day == 24:
            items.append(('OKA','TPE','MM6927','13:20','13:55'))
        else:
            items.append(('OKA','TPE','MM927','13:15','13:50'))
        if day.day == 23:
            items.append(('KIX','TPE','MM29','21:45','23:50'))
    else:
        items = [('KIX','TPE','MM23','07:15','09:45'),('KIX','TPE','MM25','10:10','12:40'),
                 ('KIX','TPE','MM27','15:25','17:55'),('KIX','KHH','MM31','10:35','13:20'),
                 ('NGO','TPE','MM723','22:50' if day.month == 12 else '22:55','01:30'),
                 ('OKA','TPE','MM921','08:15','08:55'),('OKA','TPE','MM925','13:35','14:20'),
                 ('OKA','TPE','MM929','16:50','17:35')]
        if day == date(2026,10,26):
            items.append(('KIX','TPE','MM29','21:50','00:20'))
    expected.update((str(day),origin,target,number,dep,arr) for origin,target,number,dep,arr in items)
actual = {(r['date'],r['departureAirport'],r['arrivalAirport'],r['number'],r['departure'][11:16],r['arrival'][11:16]) for r in extra}
assert actual == expected, {'missing':sorted(expected-actual),'extra':sorted(actual-expected)}
assert len(extra) == len(actual) == 594
assert len(all_rows) == len({key(r)[:4] for r in all_rows}) == 887
for r in all_rows:
    dep,arr = map(datetime.fromisoformat,(r['departure'],r['arrival']))
    assert (arr-dep).total_seconds()/60 == r['minutes']
    assert dep.utcoffset() == timedelta(hours=9) and arr.utcoffset() == timedelta(hours=8)
    assert dep.date().isoformat() == r['date']
    assert r['arrivalDayOffset'] == (arr.date()-dep.date()).days
for s in load(out/'flights.json')['sources']:
    assert hashlib.sha256((root/s['file']).read_bytes()).hexdigest() == s['sha256']
report = dict(status='passed',records=887,newUniqueRecords=594,previousTokyoRecordsRetained=293,
              duplicateIdentities=0,sourceHashesMatch=True,timeZoneDurationsMatch=True,
              method='Independent visual table transcription for extra routes plus previously audited Tokyo set',
              bookingInventoryConfirmed=False,integratedIntoWebsite=False)
(out/'independent-audit.json').write_text(json.dumps(report,indent=2),encoding='utf8')
print(json.dumps(report,indent=2))
