"""Read saved KIX public OAG schedules; explicit duration fixes arrival day."""
import importlib.util,json,re
from collections import Counter
from datetime import datetime,timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

def module(name,file):
    s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
parser=module('kix','parse-kix-schedule-evidence.py')
common=module('world','parse-world-returns.py')
common.names.update(BR='長榮航空',MM='樂桃航空',IT='台灣虎航')
root=common.ROOT/'kix';progress=common.load(root/'progress.json')
rows=[];identities=set()
for day in progress['completed']:
    file=root/(day+'.body');src=common.evidence(file)
    assert src['query']=={'from':'KIX','to':'TPE','date':day}
    commands=common.load(file);html=next(c['data'] for c in commands if c.get('selector')=='#flight-results-wrapper')
    assert set(re.findall(r'outboundDate=(\d{4}-\d{2}-\d{2})',html))=={day}
    p=parser.Parser();p.feed(html)
    for index,card in enumerate(p.root.find_all('flight-card-schedule')):
        code=card.attrs.get('data-flight-airline')
        if code not in ('BR','GK','MM','IT','JX') or card.attrs.get('data-flight-type')!='direct':continue
        route=card.find_all('flight-card-port-name')[0].text().strip()
        assert '(KIX)' in route and '(TPE)' in route and route.index('(KIX)')<route.index('(TPE)')
        number=re.search(re.escape(code)+r'\d+',card.find_all('flight-card-port-code')[0].text())[0]
        dc=card.find_all('flight-card-time-dep')[0].text().strip();ac=card.find_all('flight-card-time-arr')[0].text().strip()
        assert all(re.fullmatch(r'\d\d:\d\d',v) for v in (dc,ac))
        duration=card.find_all('flight-card-time-pass')[0].text().strip();m=re.fullmatch(r'(\d+)h\s*(\d+)m',duration);assert m,duration
        minutes=int(m[1])*60+int(m[2]);dep=common.local(day,dc,'KIX')
        arr=(dep+timedelta(minutes=minutes)).astimezone(ZoneInfo('Asia/Taipei'))
        assert arr.strftime('%H:%M')==ac
        r=common.record(code,number,'KIX','TPE',dep,arr,src,file,index,minutes,
                        sourceNotice='關西機場公開預定班表，由 OAG 提供；非航空公司自有班表，非即時或可售機位。')
        key=(r['date'],r['number']);assert key not in identities,key
        identities.add(key);rows.append(r)
out=common.ROOT/'verified/KIX';out.mkdir(parents=True,exist_ok=True)
(out/'candidate-flights.json').write_text(json.dumps(dict(records=rows,integratedIntoWebsite=False),ensure_ascii=False,indent=2),encoding='utf8')
report=dict(status=progress['state'],dates=len(progress['completed']),records=len(rows),byAirline=dict(Counter(r['airlineCode'] for r in rows)),duplicates=0,integratedIntoWebsite=False)
(out/'audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(report,ensure_ascii=False))
