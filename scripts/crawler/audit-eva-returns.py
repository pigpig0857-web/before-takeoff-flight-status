"""Independent lxml replay of saved reverse EVA tables; staging only."""
import csv, hashlib, json, re, sys
from pathlib import Path
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin, urlparse, parse_qs
from zoneinfo import ZoneInfo
from lxml import html
from collections import Counter

ROOT=Path('data/source-samples/crawler/return-gaps-20261020/eva-returns')
if '--khh' in sys.argv: ROOT=Path('data/source-samples/crawler/khh-expansion-20261020/eva')
load=lambda p:json.loads(p.read_text(encoding='utf-8-sig'))
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
p=load(ROOT/'progress.json')
zones={r[4]:r[11] for r in csv.reader(Path('data/source-samples/crawler/tigerair-research-20261013/openflights-airports.dat').read_text(encoding='utf8').splitlines()) if r[4]!='\\N'}
zones.update(TPE='Asia/Taipei',KHH='Asia/Taipei',KTI='Asia/Phnom_Penh')
countries={r['code']:r['countryCode'] for r in load(Path('src/features/flights/data/airport-directory.json'))}
expected,observed={},{}
pending=[]
for route in p['routes']:
    for r in route['records']:
        key=(r['date'],r['number'],route['origin'],route['destination'])
        assert key not in expected,key
        expected[key]=r
    for observation in route['observations']:
        file=ROOT/observation['file']; receipt=load(Path(str(file)+'.receipt.json'))
        assert sha(file)==receipt['sha256']==observation['sha256'] and receipt['status']==200
        tree=html.fromstring(file.read_bytes())
        for row in tree.xpath('//tr[contains(concat(" ",normalize-space(@class)," ")," table-dataRow--schedule ")]'):
            header=''.join(''.join(row.xpath('./th//text()')).split())
            m=re.fullmatch(r'(BR\d+)([A-Z]{3})(\d\d:\d\d)([A-Z]{3})(\d\d:\d\d)([+-]\d+)?',header)
            if not m or (m[2],m[4])!=(route['origin'],route['destination']):continue
            for cell in row.xpath('./td'):
                links=cell.xpath('.//a/@href'); images=cell.xpath('.//img/@src')
                if not links or not any(urlparse(i).path.endswith('/BR.png') for i in images):continue
                assert len(links)==1
                url=urljoin(receipt['url'],links[0]); date=datetime.strptime(parse_qs(urlparse(url).query)['Week_DT'][0],'%m/%d/%Y').date().isoformat()
                if date not in observation['dates']:continue
                key=(date,'BR'+str(int(m[1][2:])),m[2],m[4])
                value=(m[3],m[5],int(m[6] or 0))
                if key in observed:assert observed[key]==value
                observed[key]=value
assert expected.keys()==observed.keys(),(len(expected),len(observed))
records=[]
coverage=[];unresolved=[];connectingRows=0
for route in p['routes']:
    for item in route['pending']:
        if route['origin']=='VIE' and re.fullmatch(r'BR\d+VIE\d\d:\d\dBKK\d\d:\d\d(?:\+[12])?BR\d+BKK\d\d:\d\d(?:\+[12])?TPE\d\d:\d\d(?:\+[12])?',item.get('header','')):
            connectingRows+=1
        elif route['origin']=='DEL' and item.get('query','')<'2026-12-01' and item['reason'].startswith('No published table'):
            pass
        else:unresolved.append(dict(origin=route['origin'],**item))
    start=p['from']
    if route['origin']=='DEL':
        announcement=load(Path('data/source-samples/crawler/eva-yearend-2026/service-starts.json'))[0]
        proof=Path('data/source-samples/crawler/eva-yearend-2026')/announcement['file']
        assert announcement['serviceFrom']=='2026-12-01' and sha(proof)==announcement['sha256']
        assert '12月1日' in proof.read_text(encoding='utf8')
        start='2026-12-01'
    days={(datetime.fromisoformat(start).date()+timedelta(days=i)).isoformat() for i in range((datetime.fromisoformat(p['through']).date()-datetime.fromisoformat(start).date()).days+1)}
    observedDays={d for o in route['observations'] for d in o['dates']}
    coverage.append(dict(origin=route['origin'],destination=route['destination'],fromDate=start,through=p['through'],complete=days<=observedDays,observedDays=len(days&observedDays)))
for key,r in expected.items():
    assert observed[key]==(r['departureTime'],r['arrivalTime'],r['arrivalDayOffset'])
    assert p['from']<=r['date']<=p['through']
    dep=datetime.fromisoformat(r['date']+'T'+r['departureTime']).replace(tzinfo=ZoneInfo(zones[r['origin']]))
    arrday=(dep.date()+timedelta(days=r['arrivalDayOffset'])).isoformat()
    arr=datetime.fromisoformat(arrday+'T'+r['arrivalTime']).replace(tzinfo=ZoneInfo(zones[r['destination']]))
    minutes=int((arr.astimezone(timezone.utc)-dep.astimezone(timezone.utc)).total_seconds()/60)
    if not 30<=minutes<=1500:
        pending.append(dict(key=key,reason='Published offset/time requires further confirmation',minutes=minutes));continue
    records.append(dict(date=r['date'],number=r['number'],airlineCode='BR',airline='長榮航空',departureAirport=r['origin'],arrivalAirport=r['destination'],
        departure=dep.isoformat(),arrival=arr.isoformat(),departureTimeZone=zones[r['origin']],arrivalTimeZone=zones[r['destination']],arrivalDayOffset=r['arrivalDayOffset'],minutes=minutes,
        url=r['url'],fetchedAt=r['fetchedAt'],sourceSha256=r['sha256'],evidence=dict(file=str(ROOT/r['file']),detailLink=r['detailLink']),countryCode=countries[r['destination'] if r['origin']=='KHH' else r['origin']],status='published_schedule'))
identity=lambda r:(r['date'],r['airlineCode'],r['number'],r['departureAirport'],r['arrivalAirport'])
old=load(Path('src/server/data/return-flights.json'))['records']; existing={identity(r):r for r in old}
new=[]; duplicates=0;conflicts=[]
for r in records:
    prior=existing.get(identity(r))
    if prior:
        if any(prior[k]!=r[k] for k in ['departure','arrival','minutes']):conflicts.append(dict(saved=prior,candidate=r))
        else:duplicates+=1
    else:new.append(r)
assert len({identity(r) for r in new})==len(new)
out=ROOT/'verified';out.mkdir(exist_ok=True)
for name,value in [('candidate-flights.json',dict(records=sorted(new,key=lambda r:(r['date'],r['departureAirport'],r['number'])),integratedIntoWebsite=False)),('conflicts.json',conflicts),('pending.json',pending)]:
    (out/name).write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf8')
report=dict(status='passed',sourceRecords=len(expected),auditedRecords=len(records),newUniqueRecords=len(new),existingMatches=duplicates,conflicts=len(conflicts),pendingTimeRecords=len(pending),
    candidateSha256=sha(out/'candidate-flights.json'),
    byCountry=dict(Counter(r['countryCode'] for r in new)),byArrivalAirport=dict(Counter(r['arrivalAirport'] for r in new)),
    routesWithData=len({(r['departureAirport'],r['arrivalAirport']) for r in new}),routesComplete=sum(r['complete'] for r in coverage),
    excludedConnectingRowObservations=connectingRows,unresolvedSourceRows=len(unresolved),
    sourceState=p['state'],method='Independent lxml HTML extraction, source SHA256 checks, IANA timezone and UTC duration arithmetic',websiteImported=False)
(out/'independent-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
(out/'coverage.json').write_text(json.dumps(dict(routes=coverage,unresolved=unresolved),ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(report,ensure_ascii=False))
