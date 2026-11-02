"""Independent lxml source replay of ordinary airport timetable responses."""
import json,re,hashlib
from pathlib import Path
from lxml import html
from datetime import datetime,timedelta,timezone
from zoneinfo import ZoneInfo
root=Path('data/source-samples/crawler/return-world-20261019')
load=lambda p:json.loads(p.read_text(encoding='utf8'))
progress=load(root/'kix/progress.json')
assert progress['state']=='downloaded' and len(progress['completed'])==74
saved=load(root/'verified/KIX/candidate-flights.json')['records']
actual={(r['date'],r['number']):r for r in saved}
expected={}
for day in progress['completed']:
    file=root/'kix'/(day+'.body');src=load(file.with_suffix('.receipt.json'))
    assert src['status']==200 and hashlib.sha256(file.read_bytes()).hexdigest()==src['sha256']
    doc=html.fromstring(next(c['data'] for c in load(file) if c.get('selector')=='#flight-results-wrapper'))
    cards=doc.xpath('//*[contains(concat(" ",normalize-space(@class)," ")," flight-card-schedule ")]')
    for card in cards:
        code=card.get('data-flight-airline')
        if code not in ('BR','GK','MM','IT','JX') or card.get('data-flight-type')!='direct':continue
        def field(cls):return card.xpath('.//*[contains(concat(" ",normalize-space(@class)," ")," '+cls+' ")]')[0].text_content().strip()
        route=field('flight-card-port-name');assert route.index('(KIX)')<route.index('(TPE)')
        number=code+str(int(re.search(re.escape(code)+r'(\d+)',field('flight-card-port-code'))[1]))
        depclock,arrclock=field('flight-card-time-dep'),field('flight-card-time-arr')
        m=re.fullmatch(r'(\d+)h\s*(\d+)m',field('flight-card-time-pass'));assert m
        duration=int(m[1])*60+int(m[2]);dep=datetime.fromisoformat(day+'T'+depclock).replace(tzinfo=ZoneInfo('Asia/Tokyo'))
        arrival=(dep.astimezone(timezone.utc)+timedelta(minutes=duration)).astimezone(ZoneInfo('Asia/Taipei'))
        assert arrival.strftime('%H:%M')==arrclock
        ident=(day,number);assert ident not in expected
        expected[ident]=(dep.isoformat(),arrival.isoformat(),duration)
assert set(expected)==set(actual)
assert all(expected[k]==tuple(actual[k][f] for f in ('departure','arrival','minutes')) for k in expected)
report=dict(status='passed',records=len(expected),queriedDates=74,method='Independent lxml extraction and UTC duration arithmetic',sourceHashesMatch=True,duplicates=0)
(root/'verified/KIX/independent-audit.json').write_text(json.dumps(report,indent=2),encoding='utf8')
print(json.dumps(report))
