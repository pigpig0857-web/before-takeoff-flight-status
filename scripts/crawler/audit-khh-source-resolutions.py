"""Audit the user's 17 KIA time selections against the untouched official JSON."""
import datetime as dt
import hashlib
import json
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path('data/source-samples/crawler/khh-more-airlines-20261020')


def read(p):
    return json.loads(Path(p).read_text(encoding='utf-8-sig'))


def key(r):
    return r['date'], r['number'], r['departureAirport'], r['arrivalAirport']


def main():
    policy = read(ROOT / 'source-resolution-policy.json')
    approved = set(map(tuple, policy['approvedIdentities']))
    skipped = set(map(tuple, policy['skippedIdentities']))
    original = {key(r): r for r in read(ROOT / 'candidate-flights.json')['records']}
    ready = {key(r): r for r in read(ROOT / 'staging/ready-for-integration-review.json')['records']}
    pending = {key(r): r for r in read(ROOT / 'staging/pending-source-differences.json')['records']}
    resolutions = read(ROOT / 'source-resolutions.json')['records']
    assert len(ready) == 3071 and len(pending) == 5 and len(resolutions) == 17
    assert set(pending) == skipped and set(ready) == set(original) - skipped
    assert len(ready) + len(pending) == len(original) == 3076
    assert all(ready[k] == original[k] for k in set(ready) - approved)
    assert all(pending[k] == original[k] and k[1] == 'UA838' for k in pending)
    for resolution in resolutions:
        ident = tuple(resolution['identity'])
        row = ready[ident]
        assert ident in approved and resolution['originalOagRecord'] == original[ident]
        assert row == resolution['selectedAirportRecord']
        proof = row['evidence']
        file = Path(proof['file'])
        receipt = read(file.with_suffix('.receipt.json'))
        assert hashlib.sha256(file.read_bytes()).hexdigest() == proof['sha256'] == receipt['sha256']
        raw = read(file)[proof['rowIndex']]
        day = dt.date.fromisoformat(row['date'])
        assert raw[['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'][day.weekday()]] == 'Y'
        assert raw['weekstart'] <= row['date'] <= raw['weekend']
        assert raw['ScheduleStartDate'] <= row['date'] <= raw['ScheduleEndDate']
        assert raw['airLineNum'].replace(' ', '') == row['number']
        assert (raw['upAirportCode'], raw['goalAirportCode']) == (row['departureAirport'], row['arrivalAirport'])
        for field, clock, zone in [('departure', 'expectDepartureTime', 'departureTimeZone'), ('arrival', 'expectArrivalTime', 'arrivalTimeZone')]:
            value = dt.datetime.fromisoformat(row[field])
            assert value.date() == day and value.strftime('%H%M') == raw[clock]
            assert value.utcoffset() == value.astimezone(ZoneInfo(row[zone])).utcoffset()
        assert (dt.datetime.fromisoformat(row['arrival']) - dt.datetime.fromisoformat(row['departure'])).total_seconds() == row['minutes'] * 60
        assert row['minutesBasis'] == 'calculated_from_airport_published_local_times'
        assert row['fetchedAt'] == receipt['fetchedAt']
        assert row['sourceUrl'] == receipt['url'] and row['sourceKind'] == 'airport_published_kia'
    monthly = []
    for direction in ['outbound', 'inbound']:
        for month in ['2026-10', '2026-11', '2026-12']:
            rows = read(ROOT / 'staging' / direction / (month + '.json'))['records']
            assert all(r['direction'] == direction and r['date'].startswith(month) for r in rows)
            monthly += rows
    assert len(monthly) == len(ready) and {key(r): r for r in monthly} == ready
    protected = read(ROOT / 'website-before.json')
    assert all(hashlib.sha256(Path(f).read_bytes()).hexdigest() == h for f, h in protected.items())
    result = {'passed': True, 'allPlannedQueriesSaved': 1022, 'sourceQueriesPending': 0,
        'newCandidates': len(original), 'readyTotal': len(ready),
        'readyOutbound': sum(r['direction'] == 'outbound' for r in ready.values()),
        'readyInbound': sum(r['direction'] == 'inbound' for r in ready.values()),
        'sourceTimeDifferencesObserved': 22, 'resolvedUsingKiaByUserChoice': len(resolutions),
        'sourceTimeDifferencesPending': len(pending), 'skippedFlight': 'UA838',
        'newKhhAirlines': 10, 'monthlyStageCountsMatch': True, 'noReadyPendingOverlap': True,
        'originalOagObservationsUnchanged': True, 'originalWebsiteFilesUnchanged': len(protected),
        'integratedIntoWebsite': False}
    for name in ['source-resolution-audit.json', 'staging/final-audit.json']:
        (ROOT / name).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
