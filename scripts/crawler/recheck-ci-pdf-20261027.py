"""Bounded research replay of reviewed PDF sections; never writes website caches."""
import hashlib
import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pdfplumber
from ci_collection_timezones import ZoneInfo

BASE = Path('data/source-samples/crawler/ci-tpe-20261021')
OUT = BASE / 'recheck-20261027'
AIRPORTS = {'QINGDAO': 'TAO', 'WUHAN': 'WUH', 'CHENGDU SHUANGLIU': 'CTU',
            'NANJING': 'NKG', 'XIAMEN': 'XMN'}
AIRLINES = {'CI': 'China Airlines', 'AE': 'Mandarin Airlines',
            'MU': 'China Eastern Airlines', 'CZ': 'China Southern Airlines',
            'MF': 'Xiamen Airlines'}
ROW = re.compile(r'^(CI|AE)\s+(\d{3,4})\s*(?:\(([A-Z0-9]{2})\s*(\d+)\))?'
                 r'\s*([1-7 .●·]+?)\s+(\d{2}:\d{2})-(\d{2}:\d{2})'
                 r'(?:\+(\d+))?\s+(\S+)\s+(-)$')


def extract(pdf, receipt, summer=False):
    digest = hashlib.sha256(pdf.read_bytes()).hexdigest()
    assert digest == receipt.get('sha256', receipt.get('previousSha256'))
    result, rules = [], []
    with pdfplumber.open(pdf) as document:
        cover = document.pages[0].extract_text() or ''
        bounds = re.findall(r'\d{4}\.\d{2}\.\d{2}', cover)
        assert len(bounds) == 2
        valid_from, valid_until = [date.fromisoformat(v.replace('.', '-')) for v in bounds]
        assert (valid_from, valid_until) == ((date(2026, 7, 1), date(2026, 10, 24))
                                          if summer else (date(2026, 10, 25), date(2027, 3, 27)))
        page = document.pages[7]
        for direction, box in [('outbound', (0, 0, page.width / 2, page.height)),
                               ('return', (page.width / 2, 0, page.width, page.height))]:
            text = page.crop(box).extract_text() or ''
            side_file = OUT / f'{"summer" if summer else "winter"}-8-{direction}.txt'
            side_file.write_text(text, encoding='utf-8')
            current = None
            for line_number, raw in enumerate(text.splitlines(), 1):
                line = raw.strip()
                pattern = (r'^TAIPEI TAOYUAN (.+?)\s+(\d+h.*)$' if direction == 'outbound'
                           else r'^(.+?) TAIPEI TAOYUAN\s+(\d+h.*)$')
                heading = re.match(pattern, line)
                if heading:
                    label = heading[1]
                    eligible = label in AIRPORTS and (not summer or label in ('QINGDAO', 'WUHAN'))
                    durations = [int(h) * 60 + int(m or 0)
                                 for h, m in re.findall(r'(\d+)h(?:(\d+)m)?', heading[2])]
                    current = (label, min(durations), max(durations)) if eligible else None
                    continue
                if not current or not re.match(r'^(CI|AE)\s+\d', line):
                    continue
                match = ROW.fullmatch(line)
                assert match, ('Unsupported selected PDF row', direction, line)
                carrier, number, operator, operating_number, weekdays, dep_clock, arr_clock, offset, aircraft, _ = match.groups()
                number = carrier + number
                operator = operator or carrier
                operating_number = operator + operating_number if operating_number else number
                days = sorted(int(v) for v in re.findall(r'[1-7]', weekdays))
                assert days and len(days) == len(set(days))
                airport = AIRPORTS[current[0]]
                origin, destination = ('TPE', airport) if direction == 'outbound' else (airport, 'TPE')
                first, last = max(valid_from, date(2026, 10, 21)), min(valid_until, date(2026, 12, 31))
                rule = dict(number=number, origin=origin, destination=destination,
                            marketingCarrier=carrier, operatingCarrier=operator,
                            operatingNumber=operating_number, weekdays=days,
                            departureTime=dep_clock, arrivalTime=arr_clock,
                            sourceValidFrom=str(valid_from), sourceValidUntil=str(valid_until),
                            printedDurationRange=[current[1], current[2]], sourceRow=line,
                            sourcePage=8, column=direction, lineNumber=line_number,
                            pdf=str(pdf), pdfSha256=digest)
                rules.append(rule)
                for n in range((last - first).days + 1):
                    day = first + timedelta(days=n)
                    if day.isoweekday() not in days:
                        continue
                    dep = datetime.fromisoformat(str(day) + 'T' + dep_clock).replace(tzinfo=ZoneInfo('Asia/Taipei' if origin == 'TPE' else 'Asia/Shanghai'))
                    arr_day = day + timedelta(days=int(offset or 0))
                    arr = datetime.fromisoformat(str(arr_day) + 'T' + arr_clock).replace(tzinfo=ZoneInfo('Asia/Taipei' if destination == 'TPE' else 'Asia/Shanghai'))
                    minutes = int((arr.astimezone(timezone.utc) - dep.astimezone(timezone.utc)).total_seconds() / 60)
                    assert 30 <= minutes <= 1500
                    discrepancy = not current[1] <= minutes <= current[2]
                    result.append(dict(date=str(day), number=number, airlineCode=carrier,
                        origin=origin, destination=destination, departure=dep.isoformat(), arrival=arr.isoformat(),
                        departureTimeZone='Asia/Taipei' if origin == 'TPE' else 'Asia/Shanghai',
                        arrivalTimeZone='Asia/Taipei' if destination == 'TPE' else 'Asia/Shanghai',
                        minutes=minutes, printedDurationRange=[current[1], current[2]],
                        durationDiscrepancy=discrepancy, requiresReview=discrepancy,
                        marketingCarrier=carrier, operatingCarrier=operator,
                        operatingNumber=operating_number, operatingAirline=AIRLINES[operator],
                        codeshare=operator != carrier, aircraft=aircraft,
                        sourceValidFrom=str(valid_from), sourceValidUntil=str(valid_until),
                        dateBasis='Explicit cover validity and printed weekday mask; row has no narrower period.',
                        sourceLabel='華航官方電子班表（明示有效期間與飛行日）',
                        url=receipt['url'], fetchedAt=receipt.get('checkedAt', receipt.get('fetchedAt')),
                        evidence=dict(file=str(pdf), sha256=digest, page=8, column=direction,
                                      lineNumber=line_number, sourceRow=line, extractedColumn=str(side_file)),
                        integratedIntoWebsite=False))
    return result, rules


if __name__ == '__main__':
    load = lambda p: json.loads(p.read_text(encoding='utf-8-sig'))
    winter, winter_rules = extract(OUT / 'CI-timetable.pdf', load(OUT / 'timetable-version.receipt.json'))
    summer, summer_rules = extract(BASE / 'winter/downloads/ci-timetable.body',
                                  load(BASE / 'winter/downloads/ci-timetable.receipt.json'), True)
    all_rows = summer + winter
    identities = [(r['date'], r['number'], r['origin'], r['destination']) for r in all_rows]
    assert len(identities) == len(set(identities)), 'Overlapping PDF validity or weekday rules'
    old = {g['identity']: g for g in load(BASE / 'consolidated-candidates.json')['groups']}
    accepted = [r for r in all_rows if r['airlineCode'] == 'CI' and not r['requiresReview']]
    pending = [r for r in all_rows if r['requiresReview']]
    related = [r for r in all_rows if r['airlineCode'] == 'AE' and not r['requiresReview']]
    differences = []
    for row in all_rows:
        key = '|'.join([row['date'], row['number'], row['origin'], row['destination']])
        if key in old and any(o['departure'] != row['departure'] or o['arrival'] != row['arrival']
                              for o in old[key]['observations']):
            differences.append(dict(identity=key, previous=old[key], new=row, decision='preserve_all_sources_no_overwrite'))
    fresh = [r for r in accepted if '|'.join([r['date'], r['number'], r['origin'], r['destination']]) not in old]
    report = dict(checkedAt=datetime.now(timezone.utc).isoformat(),
        baselineUniqueCIIdentities=len(old), acceptedCIObservations=len(accepted),
        newAcceptedCIIdentities=len(fresh), combinedAcceptedCIIdentities=len(old) + len(fresh),
        relatedAEAcceptedIdentities=len(related), pendingCIDurationDiscrepancies=sum(r['airlineCode']=='CI' for r in pending),
        pendingAEDurationDiscrepancies=sum(r['airlineCode']=='AE' for r in pending),
        overlappingTimeDifferences=len(differences), rules=len(winter_rules)+len(summer_rules),
        targetedRecheckOnly=True, integratedIntoWebsite=False)
    for name, data in [('ci-candidates.json', {'records': accepted}),
                       ('related-ae-candidates.json', {'records': related}),
                       ('pending-duration-differences.json', pending),
                       ('source-time-differences.json', differences),
                       ('printed-rules.json', summer_rules + winter_rules), ('audit.json', report)]:
        (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
