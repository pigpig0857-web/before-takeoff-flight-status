"""Recover CI round trips from saved KIX public schedules without new requests."""
import importlib.util, json, hashlib, re
from pathlib import Path
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

ROOT = Path('data/source-samples/crawler/ci-tpe-20261021')
ROOT.mkdir(parents=True, exist_ok=True)
load = lambda p: json.loads(Path(p).read_text(encoding='utf-8-sig'))
spec = importlib.util.spec_from_file_location('kix', Path(__file__).with_name('parse-kix-schedule-evidence.py'))
parser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parser)
progress = load('data/source-samples/crawler/airline-completeness-20261016/collection-progress.json')
rows, evidence, checked = [], {}, []
for direction in ('outbound', 'return'):
    for day_offset in range(72):
        day = (datetime(2026, 10, 21) + timedelta(days=day_offset)).date().isoformat()
        if direction == 'outbound':
            entry = progress['completed']['TPE-' + day]
            file = Path(entry['file'])
            src = dict(entry, url='https://www.kansai-airport.or.jp/tw/flight/schedule?ajax_form=1')
            origin, target = 'TPE', 'KIX'
        else:
            file = Path('data/source-samples/crawler/return-world-20261019/kix') / (day + '.body')
            src = load(file.with_suffix('.receipt.json'))
            assert src['status'] == 200 and src['query'] == {'from':'KIX','to':'TPE','date':day}
            origin, target = 'KIX', 'TPE'
        raw = file.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        assert digest == src['sha256'], str(file)
        evidence[str(file)] = digest
        commands = json.loads(raw)
        html = next(c['data'] for c in commands if c.get('selector') == '#flight-results-wrapper')
        assert set(re.findall(r'outboundDate=(\d{4}-\d{2}-\d{2})', html)) == {day}
        tree = parser.Parser(); tree.feed(html)
        count = 0
        for index, card in enumerate(tree.root.find_all('flight-card-schedule')):
            if card.attrs.get('data-flight-type') != 'direct' or card.attrs.get('data-flight-airline') != 'CI': continue
            route = card.find_all('flight-card-port-name')[0].text().strip()
            assert route.index('(' + origin + ')') < route.index('(' + target + ')')
            number = re.search(r'CI\d+', card.find_all('flight-card-port-code')[0].text())[0]
            dep_clock = card.find_all('flight-card-time-dep')[0].text().strip()
            arr_clock = card.find_all('flight-card-time-arr')[0].text().strip()
            assert re.fullmatch(r'\d{2}:\d{2}', dep_clock) and re.fullmatch(r'\d{2}:\d{2}', arr_clock)
            duration = re.fullmatch(r'(\d+)h\s*(\d+)m', card.find_all('flight-card-time-pass')[0].text().strip())
            assert duration
            minutes = int(duration[1])*60+int(duration[2])
            dep_zone = 'Asia/Taipei' if origin == 'TPE' else 'Asia/Tokyo'
            arr_zone = 'Asia/Taipei' if target == 'TPE' else 'Asia/Tokyo'
            dep = datetime.fromisoformat(day+'T'+dep_clock).replace(tzinfo=ZoneInfo(dep_zone))
            arr = (dep.astimezone(timezone.utc)+timedelta(minutes=minutes)).astimezone(ZoneInfo(arr_zone))
            assert arr.strftime('%H:%M') == arr_clock
            rows.append(dict(direction=direction,date=day,number=number,airlineCode='CI',airline='中華航空',
                origin=origin,destination=target,departure=dep.isoformat(),arrival=arr.isoformat(),
                departureTimeZone=dep_zone,arrivalTimeZone=arr_zone,minutes=minutes,
                sourceLabel='關西機場公開預定班表（OAG）',url=src['url'],fetchedAt=src['fetchedAt'],
                evidence=dict(file=str(file),sha256=digest,cardIndex=index),integratedIntoWebsite=False))
            count += 1
        checked.append(dict(direction=direction,date=day,records=count))
identities=[(r['date'],r['number'],r['origin'],r['destination']) for r in rows]
assert len(identities) == len(set(identities))
existing=load('data/source-samples/crawler/airline-completeness-20261016/airlines/CI.json')['records']
prior={(r['date'],r['number']):r for r in existing if r['origin']=='TPE' and r['date']>='2026-10-21'}
for r in rows:
    if r['direction']=='outbound':
        old=prior[(r['date'],r['number'])]
        assert r['departure']==old['departure'] and r['arrival']==old['arrival']
report=dict(state='saved_candidates',fromDate='2026-10-21',through='2026-12-31',
    outbound=sum(r['direction']=='outbound' for r in rows),returns=sum(r['direction']=='return' for r in rows),
    checkedDateGroups=len(checked),rawHashesVerified=len(evidence),duplicates=0,conflictsWithPriorOutbound=0,
    integratedIntoWebsite=False,source='Kansai Airports / OAG; historical saved responses, not newly reverified',
    pending=['Other CI destinations beyond KIX need published winter schedules and evidence.'])
for name,value in [('candidate-flights.json',dict(records=rows)),('audit.json',report),('coverage.json',checked),('evidence-hashes.json',evidence),('RESEARCH_STATUS.json',report)]:
    (ROOT/name).write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(report,ensure_ascii=False))
