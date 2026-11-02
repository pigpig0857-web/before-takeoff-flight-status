"""Compare overlapping published KHH weekly rows with collected OAG flights, offline."""
import datetime as dt
import hashlib
import json
import re
from copy import deepcopy
from collections import defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path('data/source-samples/crawler/khh-more-airlines-20261020')
KIA = Path('data/source-samples/crawler/khh-expansion-20261020/probes/kia.body')


def read(p):
    return json.loads(Path(p).read_text(encoding='utf-8-sig'))


def canonical(s):
    match = re.fullmatch(r'([A-Z0-9]{2})(\d+)([A-Z]?)', s.replace(' ', '').upper())
    return match[1] + str(int(match[2])) + match[3] if match else None


def main():
    parsed = read(ROOT / 'audit.json')
    independent = read(ROOT / 'independent-audit.json')
    assert independent['passed'] and independent['sourceGroupsChecked'] == parsed['completedDateGroups']
    assert independent['newCandidatesChecked'] == parsed['newCandidates'], 'Independent audit is stale'
    receipt = read(KIA.with_suffix('.receipt.json'))
    assert receipt['status'] == 200 and hashlib.sha256(KIA.read_bytes()).hexdigest() == receipt['sha256']
    weekly = defaultdict(list)
    fields = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
    for index, row in enumerate(read(KIA)):
        number = canonical(row.get('airLineNum', ''))
        if not number or number[:2] != row.get('airLineCode'):
            continue
        if 'KHH' not in [row.get('upAirportCode'), row.get('goalAirportCode')]:
            continue
        start = max(row['weekstart'], row.get('ScheduleStartDate') or row['weekstart'], '2026-10-20')
        end = min(row['weekend'], row.get('ScheduleEndDate') or row['weekend'], '2026-12-31')
        if start > end:
            continue
        dep, arr = row.get('expectDepartureTime', ''), row.get('expectArrivalTime', '')
        if not re.fullmatch(r'\d{4}', dep) or not re.fullmatch(r'\d{4}', arr):
            continue
        day = dt.date.fromisoformat(start)
        while day.isoformat() <= end:
            if row.get(fields[day.weekday()]) == 'Y':
                weekly[(day.isoformat(), number, row['upAirportCode'], row['goalAirportCode'])].append({
                    'departureClock': dep[:2] + ':' + dep[2:], 'arrivalClock': arr[:2] + ':' + arr[2:],
                    'rowIndex': index, 'validFrom': start, 'validThrough': end,
                    'evidence': {'file': KIA.as_posix(), 'sha256': receipt['sha256'], 'fetchedAt': receipt['fetchedAt']}})
            day += dt.timedelta(days=1)
    candidates = read(ROOT / 'candidate-flights.json')['records']
    rows = list(candidates)
    rows += [r['candidateEvidence'] for r in read(ROOT / 'existing-matches.json')['records']]
    rows += [r['candidateEvidence'] for r in read(ROOT / 'time-differences.json')['records']]
    matches, differences, outside = [], [], 0
    for row in rows:
        key = (row['date'], row['number'], row['departureAirport'], row['arrivalAirport'])
        other = weekly.get(key)
        if not other:
            outside += 1
            continue
        result = {'identity': key, 'airportPublishedRows': other, 'oagRecord': row}
        if any(r['departureClock'] == row['departure'][11:16] and r['arrivalClock'] == row['arrival'][11:16] for r in other):
            matches.append(result)
        else:
            differences.append(result)
    result = {'summary': {'matchingFlights': len(matches), 'timeDifferences': len(differences),
                          'noComparableAirportRow': outside, 'websiteDataModified': False,
                          'notice': '高雄機場僅短期週班表；未列出不代表無航班，不延伸其公布有效期。差異保留待確認，不覆寫。'},
              'matchingIdentities': [r['identity'] for r in matches], 'differences': differences}
    (ROOT / 'airport-crosscheck.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    conflict_keys = {tuple(r['identity']) for r in differences}
    policy_file = ROOT / 'source-resolution-policy.json'
    policy = read(policy_file) if policy_file.exists() else None
    resolved = {}
    resolution_records = []
    if policy:
        assert policy['selectedSource'] == 'kaohsiung_airport_official'
        approved = {tuple(k) for k in policy['approvedIdentities']}
        skipped = {tuple(k) for k in policy['skippedIdentities']}
        assert approved.isdisjoint(skipped) and approved | skipped == conflict_keys
        assert len(approved) == 17 and len(skipped) == 5
        assert all(k[1] == 'UA838' for k in skipped)
        for difference in differences:
            ident = tuple(difference['identity'])
            if ident not in approved:
                continue
            original = difference['oagRecord']
            alternatives = difference['airportPublishedRows']
            assert len({(r['departureClock'], r['arrivalClock']) for r in alternatives}) == 1
            airport = alternatives[0]
            assert airport['arrivalClock'] == original['arrival'][11:16]
            assert original['arrivalDayOffset'] == 0 and original['arrival'][:10] == original['date']
            row = deepcopy(original)
            dep = dt.datetime.fromisoformat(row['date'] + 'T' + airport['departureClock'] + ':00').replace(tzinfo=ZoneInfo(row['departureTimeZone']))
            arr = dt.datetime.fromisoformat(row['date'] + 'T' + airport['arrivalClock'] + ':00').replace(tzinfo=ZoneInfo(row['arrivalTimeZone']))
            minutes = (arr.astimezone(dt.timezone.utc) - dep.astimezone(dt.timezone.utc)).total_seconds() / 60
            assert minutes.is_integer() and 0 < minutes < 720
            row.update({'departure': dep.isoformat(), 'arrival': arr.isoformat(), 'minutes': int(minutes),
                'minutesBasis': 'calculated_from_airport_published_local_times',
                'arrivalDateBasis': 'same_day_local_arrival_unchanged_from_original_evidence',
                'sourceKind': 'airport_published_kia', 'sourceUrl': receipt['url'],
                'sourceLabel': '高雄國際航空站官網公布班表', 'fetchedAt': receipt['fetchedAt'],
                'evidence': {**airport['evidence'], 'rowIndex': airport['rowIndex'],
                    'validFrom': airport['validFrom'], 'validThrough': airport['validThrough']},
                'sourceResolution': {'policyFile': policy_file.as_posix(), 'selectedBy': 'user',
                    'reason': '使用者指定這17筆依高雄機場官網時間；保留OAG差異證據。',
                    'comparisonEvidenceFile': (ROOT / 'airport-crosscheck.json').as_posix(),
                    'originalOagEvidence': original['evidence']}})
            resolved[ident] = row
            resolution_records.append({'identity': ident, 'originalOagRecord': original, 'selectedAirportRecord': row})
        assert len(resolved) == 17
    result['sourceResolution'] = {'resolvedUsingKia': len(resolved),
        'remainingDifferences': len(conflict_keys - set(resolved)), 'policyFile': policy_file.as_posix() if policy else None}
    (ROOT / 'airport-crosscheck.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (ROOT / 'source-resolutions.json').write_text(json.dumps({'records': resolution_records,
        'originalOagObservationsModified': False}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    conflict_keys -= set(resolved)
    candidates = [resolved.get((r['date'], r['number'], r['departureAirport'], r['arrivalAirport']), r) for r in candidates]
    clear = [r for r in candidates if (r['date'], r['number'], r['departureAirport'], r['arrivalAirport']) not in conflict_keys]
    pending = [r for r in candidates if (r['date'], r['number'], r['departureAirport'], r['arrivalAirport']) in conflict_keys]
    stage = ROOT / 'staging'
    stage.mkdir(exist_ok=True)
    for name, subset in [('ready-for-integration-review', clear), ('pending-source-differences', pending)]:
        (stage / (name + '.json')).write_text(json.dumps({'records': subset, 'integratedIntoWebsite': False,
            'notice': '僅已查詢七個海外機場的公布班表；ready代表通過解析、去重與已知差異排除，非保證完整航網、即時動態或可售機位。'}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    assert len(clear) + len(pending) == len(candidates)
    for direction in ['outbound', 'inbound']:
        directory = stage / direction
        directory.mkdir(exist_ok=True)
        for month in ['2026-10', '2026-11', '2026-12']:
            subset = [r for r in clear if r['direction'] == direction and r['date'].startswith(month)]
            (directory / (month + '.json')).write_text(json.dumps({'records': subset,
                'integratedIntoWebsite': False}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    by_airline = []
    for code in sorted({r['airlineCode'] for r in candidates}):
        group = [r for r in clear if r['airlineCode'] == code]
        waiting = [r for r in pending if r['airlineCode'] == code]
        by_airline.append({'code': code, 'publishedNames': sorted({r['airline'] for r in group + waiting}),
            'readyOutbound': sum(r['direction'] == 'outbound' for r in group),
            'readyInbound': sum(r['direction'] == 'inbound' for r in group),
            'pending': len(waiting),
            'overseasAirports': sorted({r['arrivalAirport'] if r['direction'] == 'outbound' else r['departureAirport'] for r in group + waiting})})
    checkpoint = {'scope': read(ROOT / 'candidate-flights.json')['scope'],
                  'collection': {k: v for k, v in parsed.items() if k != 'byAirline'},
                  'candidatesReadyForIntegrationReview': len(clear), 'candidatesPendingSourceDifferences': len(pending),
                  'resolvedUsingKia': len(resolved), 'sourceResolutionPolicy': policy_file.as_posix() if policy else None,
                  'byAirline': by_airline, 'independentAudit': independent, 'integratedIntoWebsite': False}
    (stage / 'progress.json').write_text(json.dumps(checkpoint, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result['summary'], ensure_ascii=False))


if __name__ == '__main__':
    main()
