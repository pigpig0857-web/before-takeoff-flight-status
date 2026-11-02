"""Independent lxml evidence audit; offline, with no website writes."""
import datetime as dt
import hashlib
import json
import re
from pathlib import Path
from zoneinfo import ZoneInfo
from lxml import html

ROOT = Path('data/source-samples/crawler/khh-more-airlines-20261020')


def read(p):
    return json.loads(Path(p).read_text(encoding='utf-8-sig'))


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def nodes(node, cls):
    return node.xpath('.//*[contains(concat(" ", normalize-space(@class), " "), " ' + cls + ' ")]')


def text(node, cls):
    found = nodes(node, cls)
    assert len(found) == 1, cls
    return ' '.join(found[0].text_content().split())


def identity(row):
    return row['date'], row['number'], row['departureAirport'], row['arrivalAirport']


def main():
    audit = read(ROOT / 'audit.json')
    coverage = read(ROOT / 'coverage.json')['groups']
    candidates = read(ROOT / 'candidate-flights.json')['records']
    matches = read(ROOT / 'existing-matches.json')['records']
    differences = read(ROOT / 'time-differences.json')['records']
    conflicts = read(ROOT / 'source-conflicts.json')['records']
    invalid = read(ROOT / 'invalid-cards.json')['records']
    assert not conflicts, 'Source conflicts require separate review'
    records = candidates + [r['candidateEvidence'] for r in matches + differences]
    assert len(records) == audit['uniqueSourceFlights']
    assert len({identity(r) for r in records}) == len(records)
    assert len(candidates) == audit['newCandidates']
    by_source = {(r['evidence']['file'], r['evidence']['cardIndex']): r for r in records}
    invalid_indices = {(r['evidenceFile'], r['cardIndex']) for r in invalid}
    checked = 0
    excluded_connecting = 0
    for group in coverage:
        file = group['evidenceFile']
        proof = read(Path(file).with_suffix('.receipt.json'))
        assert proof['status'] == 200 and sha(file) == proof['sha256']
        content = next(c['data'] for c in read(file) if c.get('selector') == '#flight-results-wrapper')
        assert set(re.findall(r'outboundDate=(\d{4}-\d{2}-\d{2})', content)) == {group['date']}
        tree = html.fromstring(content)
        primary_count = 0
        for i, card in enumerate(nodes(tree, 'flight-card-schedule')):
            if card.get('data-flight-type') != 'direct':
                excluded_connecting += 1
                continue
            if (file, i) in invalid_indices:
                continue
            r = by_source[(file, i)]
            assert r['evidence']['sha256'] == proof['sha256']
            assert re.findall(r'\(([A-Z]{3})\)', text(card, 'flight-card-port-name')) == [r['departureAirport'], r['arrivalAirport']]
            raw_number = re.match(r'([A-Z0-9]{2})(\d+)([A-Z]?)', text(card, 'flight-card-port-code'))
            assert raw_number and raw_number[1] + str(int(raw_number[2])) + raw_number[3] == r['number']
            assert r['airlineCode'] == card.get('data-flight-airline')
            assert 'KHH' in [r['departureAirport'], r['arrivalAirport']]
            assert '2026-10-20' <= r['date'] <= '2026-12-31'
            dep, arr = [dt.datetime.fromisoformat(r[f]) for f in ['departure', 'arrival']]
            assert dep.date().isoformat() == r['date']
            assert dep.strftime('%H:%M') == text(card, 'flight-card-time-dep')
            assert arr.strftime('%H:%M') == re.search(r'\d{2}:\d{2}', text(card, 'flight-card-time-arr'))[0]
            assert dep.utcoffset() == dep.astimezone(ZoneInfo(r['departureTimeZone'])).utcoffset()
            assert arr.utcoffset() == arr.astimezone(ZoneInfo(r['arrivalTimeZone'])).utcoffset()
            duration = re.fullmatch(r'(\d+)h\s*(\d+)m', text(card, 'flight-card-time-pass'))
            assert duration and int(duration[1]) * 60 + int(duration[2]) == r['minutes']
            assert (arr - dep).total_seconds() == r['minutes'] * 60
            assert r['arrivalDayOffset'] == (arr.date() - dep.date()).days
            assert r['fetchedAt'] == proof['fetchedAt']
            assert r['terminal'] is None and r['aircraft'] is None
            assert r['operatingAirline'] is None and r['codeshare'] is None
            assert r['integratedIntoWebsite'] is False
            checked += 1
            primary_count += 1
        assert primary_count == group['validatedPrimaryFlights']
    assert checked == audit['uniqueSourceFlights'] + audit['repeatedPrimaryCards']
    assert excluded_connecting == audit['skipped']['connectingCards']
    protected = read(ROOT / 'website-before.json')
    assert all(sha(f) == h for f, h in protected.items()), 'Website baseline modified'
    result = {'passed': True, 'independentHtmlParser': 'lxml', 'sourceGroupsChecked': len(coverage),
              'sourcePrimaryFlightsChecked': checked, 'newCandidatesChecked': len(candidates),
              'connectingCardsExcluded': excluded_connecting, 'uniqueCandidateIdentities': len(candidates),
              'existingSameTimeFlightsNotAddedAgain': len(matches), 'timeDifferencesKeptSeparate': len(differences),
              'invalidCardsExcluded': len(invalid), 'originalWebsiteFilesUnchanged': len(protected),
              'integratedIntoWebsite': False}
    (ROOT / 'independent-audit.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
