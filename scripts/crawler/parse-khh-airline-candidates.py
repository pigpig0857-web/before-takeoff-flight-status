"""Parse saved KHH airport/OAG evidence, without changing website data or fetching."""
import datetime as dt
import hashlib
import importlib.util
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path('data/source-samples/crawler/khh-more-airlines-20261020')
SOURCE = 'https://www.kansai-airport.or.jp/tw/flight/schedule'
ZONES = {'KHH': 'Asia/Taipei', 'KIX': 'Asia/Tokyo', 'NRT': 'Asia/Tokyo',
         'ICN': 'Asia/Seoul', 'HKG': 'Asia/Hong_Kong', 'BKK': 'Asia/Bangkok',
         'MNL': 'Asia/Manila', 'KUL': 'Asia/Kuala_Lumpur'}
COUNTRIES = {'KHH': 'TW', 'KIX': 'JP', 'NRT': 'JP', 'ICN': 'KR', 'HKG': 'HK',
             'BKK': 'TH', 'MNL': 'PH', 'KUL': 'MY'}
EXISTING_KHH_AIRLINES = {'BR', 'MM', 'IT', '7C', 'VN', 'GK', 'SL'}


def read(p):
    return json.loads(Path(p).read_text(encoding='utf-8-sig'))


def digest(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def save(name, value):
    p = ROOT / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def canonical(n):
    m = re.fullmatch(r'([A-Z0-9]{2})(\d+)([A-Z]?)', n.upper().replace(' ', ''))
    assert m, n
    return m[1] + str(int(m[2])) + m[3]


def key(r):
    return (r['date'], canonical(r['number']), r['departureAirport'], r['arrivalAirport'])


def utc(s):
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00')).astimezone(dt.timezone.utc)


def same(a, b):
    return all(utc(a[f]) == utc(b[f]) for f in ['departure', 'arrival'])


def main():
    protected = read(ROOT / 'website-before.json')
    assert all(digest(f) == h for f, h in protected.items()), 'Website data changed during collection'
    baseline = defaultdict(list)
    for f in sorted(Path('src/server/data').glob('*flights.json')):
        content = read(f)
        for i, row in enumerate(content.get('records', []) if isinstance(content, dict) else content):
            if not ('2026-10-20' <= row.get('date', '') <= '2026-12-31') or not row.get('number'):
                continue
            if f.name == 'return-flights.json':
                r = row
            elif row.get('airport'):
                r = {**row, 'departureAirport': row.get('origin', 'TPE'), 'arrivalAirport': row['airport']}
            else:
                continue
            baseline[key(r)].append({'file': f.as_posix(), 'index': i, 'record': r})

    spec = importlib.util.spec_from_file_location('saved_schedule', 'scripts/crawler/parse-kix-schedule-evidence.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    progress = read(sys.argv[1] if len(sys.argv) > 1 else ROOT / 'progress.json')
    observed = defaultdict(list)
    errors, coverage, sources = [], [], {}
    skipped = Counter()
    fd_file = Path('data/source-samples/crawler/destination-expansion-20261016/official-fd-airline-code.body')
    fd_receipt = read(fd_file.with_suffix('.receipt.json'))
    assert digest(fd_file) == fd_receipt['sha256'] and fd_receipt['status'] == 200
    assert re.search(r'Thai AirAsia.{0,100}flight code.{0,20}FD', fd_file.read_text(encoding='utf-8'), re.I)

    for qid, item in sorted(progress['completed'].items()):
        p = Path(item['file'])
        receipt = read(p.with_suffix('.receipt.json'))
        assert receipt['status'] == 200 and digest(p) == receipt['sha256'] == item['sha256'], qid
        commands = read(p)
        html = next(c['data'] for c in commands if c.get('selector') == '#flight-results-wrapper')
        assert set(re.findall(r'outboundDate=(\d{4}-\d{2}-\d{2})', html)) == {item['date']}, qid
        parser = module.Parser()
        parser.feed(html)
        group = []
        group_errors = []
        for index, card in enumerate(parser.root.find_all('flight-card-schedule')):
            if card.attrs.get('data-flight-type') != 'direct':
                skipped['connectingCards'] += 1
                continue

            def text(cls):
                nodes = card.find_all(cls)
                assert len(nodes) == 1, (cls, len(nodes))
                return ' '.join(nodes[0].text().split())

            try:
                origin, to, date = item['from'], item['to'], item['date']
                assert re.findall(r'\(([A-Z]{3})\)', text('flight-card-port-name')) == [origin, to], 'Route mismatch'
                identity_text = text('flight-card-port-code')
                match = re.fullmatch(r'([A-Z0-9]{2}\d+[A-Z]?)(?:\s*/\s*(.+))?', identity_text)
                assert match, ('Primary number', identity_text)
                code = card.attrs['data-flight-airline']
                assert canonical(match[1])[:2] == code
                assert match[2] or code == 'FD', ('Airline name needs evidence', identity_text)
                clock = text('flight-card-time-dep')
                assert re.fullmatch(r'\d{2}:\d{2}', clock) and card.attrs['data-flight-departure'] == clock
                duration = re.fullmatch(r'(\d+)h\s*(\d+)m', text('flight-card-time-pass'))
                assert duration, 'Missing duration'
                minutes = int(duration[1]) * 60 + int(duration[2])
                assert 0 < minutes < 720, ('Implausible direct Asia duration', minutes)
                dep = dt.datetime.fromisoformat(f'{date}T{clock}:00').replace(tzinfo=ZoneInfo(ZONES[origin]))
                arr = (dep.astimezone(dt.timezone.utc) + dt.timedelta(minutes=minutes)).astimezone(ZoneInfo(ZONES[to]))
                arrival_text = text('flight-card-time-arr')
                arrival_clock = re.search(r'\d{2}:\d{2}', arrival_text)
                assert arrival_clock and arr.strftime('%H:%M') == arrival_clock[0], 'Arrival clock/duration mismatch'
                marker = re.search(r'\+(\d+)', arrival_text)
                if marker:
                    assert (arr.date() - dep.date()).days == int(marker[1]), 'Arrival day marker mismatch'
                row = {
                    'date': date, 'number': canonical(match[1]), 'publishedNumber': match[1],
                    'airlineCode': code, 'airline': match[2] or '泰國亞洲航空',
                    'airlineNameBasis': 'published_label' if match[2] else 'official_FD_code_reference',
                    'departureAirport': origin, 'arrivalAirport': to,
                    'direction': 'outbound' if origin == 'KHH' else 'inbound',
                    'countryCode': COUNTRIES[to if origin == 'KHH' else origin],
                    'departure': dep.isoformat(), 'arrival': arr.isoformat(),
                    'departureTimeZone': ZONES[origin], 'arrivalTimeZone': ZONES[to],
                    'arrivalDayOffset': (arr.date() - dep.date()).days, 'minutes': minutes,
                    'terminal': None, 'arrivalTerminal': None, 'aircraft': None,
                    'operatingAirline': None, 'operatingNumber': None, 'codeshare': None,
                    'sourceUrl': SOURCE, 'sourceKind': 'airport_published_oag',
                    'sourceLabel': '關西機場公開預定班表（OAG）', 'fetchedAt': receipt['fetchedAt'],
                    'arrivalDateBasis': 'published_day_marker_and_duration' if marker else 'published_duration_and_local_clock',
                    'scheduledOnly': True, 'integratedIntoWebsite': False,
                    'evidence': {'file': p.as_posix(), 'sha256': receipt['sha256'], 'cardIndex': index,
                                 'query': {'from': origin, 'to': to, 'date': date}, 'requestUrl': receipt['url']},
                }
                if code == 'FD' and not match[2]:
                    row['airlineNameEvidence'] = {'file': fd_file.as_posix(), 'sha256': fd_receipt['sha256']}
                observed[key(row)].append(row)
                group.append(row)
            except (AssertionError, ValueError, KeyError) as error:
                group_errors.append({'id': qid, 'cardIndex': index, 'reason': str(error),
                                     'cardText': ' '.join(card.text().split()), 'evidenceFile': p.as_posix()})
        errors.extend(group_errors)
        coverage.append({'id': qid, 'from': item['from'], 'to': item['to'], 'date': item['date'],
                         'validatedPrimaryFlights': len(group), 'invalidPrimaryCards': len(group_errors),
                         'airlines': sorted({r['airlineCode'] for r in group}), 'reused': bool(item.get('reused')),
                         'evidenceFile': p.as_posix()})
        sources[p.as_posix()] = receipt['sha256']

    new, matches, differences, conflicts = [], [], [], []
    repeats = 0
    for ident, versions in sorted(observed.items()):
        row = versions[0]
        if any(not same(row, v) for v in versions[1:]):
            conflicts.append({'identity': ident, 'versions': versions})
            continue
        repeats += len(versions) - 1
        existing = baseline.get(ident, [])
        if not existing:
            new.append(row)
            continue
        result = {'identity': ident, 'candidateEvidence': row, 'existingRecords': [
            {'file': v['file'], 'index': v['index'], 'departure': v['record']['departure'],
             'arrival': v['record']['arrival'], 'sameTimes': same(row, v['record'])} for v in existing]}
        (matches if all(v['sameTimes'] for v in result['existingRecords']) else differences).append(result)

    assert len({key(r) for r in new}) == len(new) and not {key(r) for r in new} & set(baseline)
    assert len(observed) == len(new) + len(matches) + len(differences) + len(conflicts)
    by_airline = []
    for code in sorted({r['airlineCode'] for r in new}):
        rows = [r for r in new if r['airlineCode'] == code]
        entry = {'code': code, 'publishedNames': sorted({r['airline'] for r in rows}),
                 'newToKhhWebsite': code not in EXISTING_KHH_AIRLINES,
                 'outbound': sum(r['direction'] == 'outbound' for r in rows),
                 'inbound': sum(r['direction'] == 'inbound' for r in rows),
                 'routes': dict(sorted(Counter(r['departureAirport'] + '-' + r['arrivalAirport'] for r in rows).items())),
                 'from': min(r['date'] for r in rows), 'through': max(r['date'] for r in rows)}
        by_airline.append(entry)
        save(f'airlines/{code}.json', {'records': rows, 'summary': entry, 'integratedIntoWebsite': False})
    save('candidate-flights.json', {'scope': progress['scope'], 'records': new, 'integratedIntoWebsite': False,
                                  'scopeNotice': '僅已查詢七個海外機場往返高雄的公開預定班表，並非各公司完整航網；共用班號與轉機未另計。'})
    save('existing-matches.json', {'records': matches, 'addedAgain': False})
    save('time-differences.json', {'records': differences, 'automaticOverwrite': False})
    save('source-conflicts.json', {'records': conflicts})
    save('invalid-cards.json', {'records': errors, 'imported': False})
    save('coverage.json', {'groups': coverage, 'expected': progress['expected'], 'pending': progress['pending']})
    for month in ['2026-10', '2026-11', '2026-12']:
        save(f'months/{month}.json', {'records': [r for r in new if r['date'].startswith(month)]})
    audit = {'state': progress['state'], 'expectedDateGroups': progress['expected'],
             'completedDateGroups': len(coverage), 'pendingDateGroups': len(progress['pending']),
             'unqueriedDateGroups': progress['expected'] - len(coverage) - len(progress['pending']),
             'reusedDateGroups': sum(r['reused'] for r in coverage), 'uniqueSourceFlights': len(observed),
             'newCandidates': len(new), 'existingSameTimeFlights': len(matches),
             'existingTimeDifferences': len(differences), 'sourceConflicts': len(conflicts),
             'repeatedPrimaryCards': repeats, 'invalidPrimaryCards': len(errors),
             'groupsWithNoValidDirectFlights': sum(r['validatedPrimaryFlights'] == 0 for r in coverage),
             'candidateDuplicates': 0, 'overlapWithWebsite': 0, 'verifiedSourceFiles': len(sources),
             'unchangedWebsiteFiles': len(protected), 'skipped': dict(skipped), 'byAirline': by_airline,
             'integratedIntoWebsite': False}
    save('audit.json', audit)
    assert all(digest(f) == h for f, h in protected.items())
    print(json.dumps({k: v for k, v in audit.items() if k != 'byAirline'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
