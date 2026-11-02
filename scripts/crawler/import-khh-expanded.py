"""Import the approved KHH round-trip batch into separate catalogue files."""
import datetime as dt
import hashlib
import json
from pathlib import Path

ROOT = Path('data/source-samples/crawler/khh-more-airlines-20261020')
OUT = Path('src/server/data/kaohsiung-expanded-flights.json')
BACK = Path('src/server/data/kaohsiung-expanded-returns.json')
NAMES = {'CI': '中華航空', 'CX': '國泰航空', 'UO': '香港快運航空', 'TW': '泰瑞航空',
         'UA': '聯合航空', 'TG': '泰國航空', 'AK': '馬來西亞亞洲航空',
         'FD': '泰國亞洲航空', '5J': '宿霧太平洋航空', 'Z2': '菲律賓亞洲航空'}
CITIES = {'NRT': '東京', 'KIX': '大阪', 'ICN': '首爾', 'HKG': '香港',
          'BKK': '曼谷', 'MNL': '馬尼拉', 'KUL': '吉隆坡'}


def read(p):
    return json.loads(Path(p).read_text(encoding='utf-8-sig'))


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def save(p, value):
    with Path(p).open('x', encoding='utf-8') as f:
        f.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def main():
    directory = {r['code']: r for r in read('src/features/flights/data/airport-directory.json')}
    report = read(ROOT / 'staging/final-audit.json')
    rows = read(ROOT / 'staging/ready-for-integration-review.json')['records']
    assert report['passed'] and len(rows) == report['readyTotal'] == 3071
    assert report['resolvedUsingKiaByUserChoice'] == 17
    pending = read(ROOT / 'staging/pending-source-differences.json')['records']
    assert len(pending) == 5 and all(r['number'] == 'UA838' for r in pending)
    folder = ROOT / 'integration'
    folder.mkdir(exist_ok=True)
    receipt_file = folder / 'import.json'
    if receipt_file.exists():
        receipt = read(receipt_file)
        assert sha(OUT) == receipt['outboundSha256'] and sha(BACK) == receipt['inboundSha256']
        print(json.dumps({'state': 'already_imported', **receipt}, ensure_ascii=False))
        return
    assert not OUT.exists() and not BACK.exists(), 'Review partial import before continuing'
    protected = read(ROOT / 'website-before.json')
    assert all(sha(f) == h for f, h in protected.items())
    save(folder / 'before.json', protected)
    outgoing, incoming = [], []
    verified = {}
    for r in rows:
        assert '2026-10-20' <= r['date'] <= '2026-12-31'
        code = r['airlineCode']
        assert code in NAMES and r['number'].startswith(code)
        proof = r['evidence']
        if proof['file'] not in verified:
            verified[proof['file']] = sha(proof['file'])
        assert verified[proof['file']] == proof['sha256']
        kia = r['sourceKind'] == 'airport_published_kia'
        assert kia or r['sourceKind'] == 'airport_published_oag'
        kind = 'collected_khh_airport' if kia else 'collected_khh_oag'
        label = '高雄國際航空站官網公布班表' if kia else '關西機場公開預定班表（OAG）'
        notice = '依使用者指定採用高雄機場官網時間，保留另一來源差異；預定時間可能異動。' if kia else '機場公開預定班表（OAG），非即時動態。'
        evidence = {**proof, 'sourceUrl': r['sourceUrl'] if kia else proof['requestUrl']}
        if r['direction'] == 'outbound':
            assert r['departureAirport'] == 'KHH'
            airport = r['arrivalAirport']
            if not kia:
                evidence['query'] = {'origin': 'KHH', 'airport': airport, 'date': r['date']}
            outgoing.append({'origin': 'KHH', 'number': r['number'], 'airline': NAMES[code],
                'date': r['date'], 'departure': r['departure'], 'arrival': r['arrival'],
                'arrivalTimeZone': r['arrivalTimeZone'], 'airport': airport, 'candidateAirport': None,
                'destination': CITIES[airport], 'destinationEnglish': directory[airport]['municipality'],
                'countryCode': directory[airport]['countryCode'], 'terminal': None, 'arrivalTerminal': None,
                'aircraft': None, 'minutes': r['minutes'], 'kind': kind, 'label': label,
                'url': r['sourceUrl'], 'fetchedAt': r['fetchedAt'], 'operatingAirline': None,
                'operatingNumber': None, 'codeshare': None, 'page': None, 'evidence': evidence,
                'sourceNotice': notice,
                **({'sourceResolution': r['sourceResolution'], 'minutesBasis': r['minutesBasis']} if kia else {})})
        else:
            assert r['arrivalAirport'] == 'KHH'
            incoming.append({**{k: r[k] for k in ['date', 'number', 'airlineCode', 'departureAirport',
                'arrivalAirport', 'departure', 'arrival', 'departureTimeZone', 'arrivalTimeZone',
                'arrivalDayOffset', 'minutes', 'fetchedAt', 'countryCode']},
                'airline': NAMES[code], 'url': r['sourceUrl'], 'sourceKind': kind, 'sourceLabel': label,
                'sourceSha256': proof['sha256'], 'sourceNotice': notice, 'evidence': evidence,
                'terminal': None, 'arrivalTerminal': None, 'aircraft': None,
                **({'sourceResolution': r['sourceResolution'], 'minutesBasis': r['minutesBasis']} if kia else {})})
    assert len(outgoing) == 1533 and len(incoming) == 1538
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    coverage = []
    for kind, code in sorted({(r['kind'], r['number'][:2]) for r in outgoing}):
        group = [r for r in outgoing if r['kind'] == kind and r['number'][:2] == code]
        coverage.append({'kind': kind, 'label': NAMES[code] + ' · ' + group[0]['label'],
            'url': group[0]['url'], 'fetchedAt': min(r['fetchedAt'] for r in group),
            'description': '高雄往返已收錄的七個海外機場之部分預定航線，非完整航網。',
            'dates': sorted({r['date'] for r in group}), 'records': len(group)})
    save(OUT, {'version': 1, 'importedAt': now, 'records': outgoing, 'coverage': coverage})
    save(BACK, {'version': 1, 'importedAt': now, 'from': '2026-10-20', 'through': '2026-12-31',
        'partial': True, 'records': incoming, 'provenance': (ROOT / 'staging/progress.json').as_posix()})
    assert all(sha(f) == h for f, h in protected.items())
    receipt = {'importedAt': now, 'outbound': len(outgoing), 'inbound': len(incoming),
        'total': len(rows), 'sourceResolutionRecords': 17, 'skippedUA838': 5,
        'outboundFile': OUT.as_posix(), 'inboundFile': BACK.as_posix(),
        'outboundSha256': sha(OUT), 'inboundSha256': sha(BACK), 'oldWebsiteFilesUnchanged': len(protected)}
    save(receipt_file, receipt)
    print(json.dumps(receipt, ensure_ascii=False))


if __name__ == '__main__':
    main()
