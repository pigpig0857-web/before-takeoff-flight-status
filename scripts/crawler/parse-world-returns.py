"""Offline reverse timetable extraction with durable source evidence and gaps."""
import argparse,csv,hashlib,json,re
from collections import Counter
from datetime import date,datetime,timedelta,timezone
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from zoneinfo import ZoneInfo
import pdfplumber
from pypdf import PdfReader

ROOT=Path('data/source-samples/crawler/return-world-20261019')
START,END='2026-10-19','2026-12-31'
load=lambda p:json.loads(p.read_text(encoding='utf-8-sig'))
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
ZONES=Path('data/source-samples/crawler/tigerair-research-20261013/openflights-airports.dat')
assert sha(ZONES)==load(Path(str(ZONES)+'.receipt.json'))['sha256']
zones={r[4]:r[11] for r in csv.reader(ZONES.read_text(encoding='utf8').splitlines()) if r[4]!='\\N'}
zones.update(TPE='Asia/Taipei',KHH='Asia/Taipei')
countries={r['code']:r['countryCode'] for r in load(Path('src/features/flights/data/airport-directory.json'))}
names={'JX':'星宇航空','7C':'濟州航空','VN':'越南航空','PR':'菲律賓航空','GK':'捷星日本航空','NU':'日本越洋航空'}
def days(a,b):
    a,b=map(date.fromisoformat,(a,b))
    return [(a+timedelta(days=i)).isoformat() for i in range((b-a).days+1)]
def evidence(file,receipt=None):
    rec=load(receipt or file.with_suffix('.receipt.json'))
    assert rec.get('status',rec.get('httpStatus'))==200 and sha(file)==rec['sha256'],str(file)
    return rec
def record(code,number,origin,target,dep,arr,src,file,row,minutes=None,**extra):
    assert origin not in ('TPE','KHH') and target in ('TPE','KHH')
    assert dep.astimezone(ZoneInfo(zones[origin])).isoformat()==dep.isoformat()
    assert arr.astimezone(ZoneInfo('Asia/Taipei')).isoformat()==arr.isoformat()
    duration=int((arr.astimezone(timezone.utc)-dep.astimezone(timezone.utc)).total_seconds()/60)
    assert 30<=duration<=1500 and (minutes is None or duration==minutes),(number,dep,arr,minutes,duration)
    return dict(date=dep.date().isoformat(),number=code+str(int(re.sub(r'^'+re.escape(code),'',number))),
                airlineCode=code,airline=names[code],departureAirport=origin,arrivalAirport=target,
                departure=dep.isoformat(),arrival=arr.isoformat(),departureTimeZone=zones[origin],arrivalTimeZone='Asia/Taipei',
                arrivalDayOffset=(arr.date()-dep.date()).days,minutes=duration,
                url=src['url'],fetchedAt=src['fetchedAt'],sourceSha256=src['sha256'],
                evidence=dict(file=str(file),rowIndex=row),countryCode=countries[origin],
                status='published_schedule',terminal=None,arrivalTerminal=None,aircraft=None,**extra)
def local(day,clock,airport,offset=0):
    d=date.fromisoformat(day)+timedelta(days=offset)
    return datetime.fromisoformat(f'{d}T{clock.zfill(5)}').replace(tzinfo=ZoneInfo(zones[airport]))
def collect(code,latest=False):
    rows,pending,cells={},[],set()
    def add(r):
        k=(r['date'],r['airlineCode'],r['number'],r['departureAirport'],r['arrivalAirport'])
        if k in rows:
            assert all(rows[k][f]==r[f] for f in ('departure','arrival','minutes')),(k,'source conflict')
        else: rows[k]=r
    if code in ('JX','7C','VN'):
        folder=ROOT/{'JX':'starlux','7C':'jeju','VN':'vietnam'}[code]
        if code=='JX': plan=load(folder/'plan.json')['requests']
        else: plan=load(ROOT/('jeju-plan.json' if code=='7C' else 'vn-daily-plan.json'))['requests']
        for query in plan:
            if code=='JX':
                origin,target,center=query['origin'],query['destination'],query['date']
                file=folder/f"{origin}-{query['week']}.json"
            elif code=='7C':
                origin,target=query['body']['depStn'],query['body']['arrStn']
                center=datetime.strptime(query['body']['startDate'],'%Y%m%d').date().isoformat()
                file=folder/(query['id']+'.body')
            else:
                q=parse_qs(urlparse(query['url']).query)
                origin,target,center=(q[x][0] for x in ('originLocationCode','destinationLocationCode','departureDate'))
                file=folder/(query['id']+'.body')
            if not file.exists() or not file.with_suffix('.receipt.json').exists():
                pending.append(dict(origin=origin,destination=target,date=center,reason='source_not_saved',query=query));continue
            src=evidence(file); raw=load(file)
            if code=='JX':
                assert raw['success'] and raw['message']['code']=='00000'
                items=raw['data']['timetable']
            elif code=='7C':assert raw['code']=='0000';items=raw['data']['dep']
            else:
                items=raw.get('data',{}).get('departureFlight',{}).get('scheduleItems')
                if not raw.get('success') or not isinstance(items,list):
                    pending.append(dict(origin=origin,destination=target,date=center,reason='incomplete_source_response',file=str(file)));continue
            for d in (days((date.fromisoformat(center)-timedelta(days=3)).isoformat(),(date.fromisoformat(center)+timedelta(days=3)).isoformat()) if code!='VN' else [center]):
                if START<=d<=END:cells.add((origin,target,d))
            for index,item in enumerate(items):
                if code=='JX':
                    assert item['depAirport']==origin and item['arrAirport']==target
                    if item['stops'] or item['operatingAirlineCode']!='JX':continue
                    for d in item['schedule']:
                        assert abs((date.fromisoformat(d)-date.fromisoformat(center)).days)<=3
                        if not START<=d<=END or d in item['cargoOnly']:continue
                        dep,arr=local(d,item['depTime'],origin),local(d,item['arrTime'],target,item['arrivalDaysDifference'])
                        add(record(code,item['flightNo'],origin,target,dep,arr,src,file,index,item['duration'],approvalPending=d in item['pendingApproval']))
                elif code=='7C':
                    desc,leg,identity=item['designator'],item['legDetails'],item['identifier']
                    assert desc['origin']==origin and desc['destination']==target
                    dep=datetime.fromisoformat(leg['departureTimeUtc'].replace('Z','+00:00')).astimezone(ZoneInfo(zones[origin]))
                    arr=datetime.fromisoformat(leg['arrivalTimeUtc'].replace('Z','+00:00')).astimezone(ZoneInfo('Asia/Taipei'))
                    assert dep.replace(tzinfo=None).isoformat()==desc['departure'] and arr.replace(tzinfo=None).isoformat()==desc['arrival']
                    assert abs((dep.date()-date.fromisoformat(center)).days)<=3
                    if not START<=str(dep.date())<=END:continue
                    assert identity['carrierCode']=='7C' and leg['codeShareIndicator']=='NonCodeShare'
                    add(record(code,identity['identifier'],origin,target,dep,arr,src,file,index))
                else:
                    segments=item.get('connectedFlights',[])
                    if len(segments)!=1:continue
                    segment=segments[0];info=segment['flightInfo'];a,b=info['departureLocation'],info['arrivalLocation']
                    if a['locationCode']!=origin or b['locationCode']!=target or segment['numberOfStops']!=0:continue
                    if info['marketingAirlineCode']!='VN' or info['operatingAirlineCode']!='VN':continue
                    dep=datetime.fromisoformat(a['dateTime']).replace(tzinfo=timezone(timedelta(hours=a['dateTimeZoneGmtOffset'])))
                    arr=datetime.fromisoformat(b['dateTime']).replace(tzinfo=timezone(timedelta(hours=b['dateTimeZoneGmtOffset'])))
                    if str(dep.date())!=center or not START<=center<=END:continue
                    assert dep.strftime('%A').lower() in segment['operatingDays']
                    assert segment['validityPeriod']['start'][:10]<=center<=segment['validityPeriod']['end'][:10]
                    add(record(code,info['marketingFlightNumber'],origin,target,dep,arr,src,file,index,info['duration']/60))
    elif code=='PR':
        base=Path('data/source-samples/crawler/new-airlines-20261015')
        for season,page,a,b in [('summer',3,'2026-03-29','2026-10-24'),('winter',4,'2026-10-25','2027-03-27')]:
            file=base/f'pr-international-{season}.body'
            if latest:file=ROOT/'pdf-refresh'/('pr-international-winter-current.body' if season=='winter' else 'pr-international-summer.body')
            src=evidence(file)
            with pdfplumber.open(file) as doc:
                p=doc.pages[page-1];lines=p.crop((0,0,p.width/2,p.height)).extract_text().splitlines()
            start=lines.index('MANILA to TAIPEI'); section=[]
            for line in lines[start+1:]:
                if ' to ' in line:break
                m=re.fullmatch(r'PR (\d+) (Daily|(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))*)(?: \(([^)]+)\))? (\d\d:\d\d) (\d\d:\d\d)',line)
                assert m,line
                number,freq,note,depclock,arrclock=m.groups()
                if note:
                    assert season=='winter' and number=='896' and note=='Feb 04-11'
                    continue # Explicitly outside approved departure range.
                for d in days(max(a,START),min(b,END)):
                    cells.add(('MNL','TPE',d))
                    if freq!='Daily' and date.fromisoformat(d).weekday() not in [{'Mo':0,'Tu':1,'We':2,'Th':3,'Fr':4,'Sa':5,'Su':6}[x] for x in freq.split('-')]:continue
                    add(record(code,number,'MNL','TPE',local(d,depclock,'MNL'),local(d,arrclock,'TPE'),src,file,start+len(section)+1))
                section.append(line)
            assert len(section)==(3 if season=='summer' else 2)
    elif code=='GK':
        base=Path('data/source-samples/crawler/new-airlines-20261014')
        routes={'11':('NRT','TPE'),'13':('NRT','TPE'),'15':('NRT','TPE'),'17':('NRT','KHH'),'55':('KIX','TPE'),'57':('KIX','TPE'),'97':('OKA','KHH')}
        for season in ('summer','winter'):
            file=(ROOT/'pdf-refresh' if latest else base)/f'jetstar-{season}-pdf.body';src=evidence(file)
            # Two independent extraction engines must agree on return rows.
            with pdfplumber.open(file) as doc:text=doc.pages[0].extract_text()
            second=PdfReader(file).pages[0].extract_text(extraction_mode='layout')
            for index,line in enumerate(text.splitlines()):
                m=re.match(r'GK(11|13|15|17|55|57|97) (\d\d:\d\d) ▲ (\d\d:\d\d) (Daily|[.1-7]{7}) (\S+)',line)
                if not m:continue
                n,dc,ac,freq,period=m.groups();origin,target=routes[n]
                assert all(v in second for v in ('GK'+n,dc,ac,period))
                if not re.fullmatch(r'\d{1,2}/\d{1,2}(?:-\d{1,2}/\d{1,2})?',period):
                    pending.append(dict(origin=origin,destination=target,number='GK'+n,reason='malformed_published_validity',rawPeriod=period,file=str(file),line=line));continue
                ends=period.split('-')
                def convert(v):
                    month,day=map(int,v.split('/'));return date(2027 if season=='winter' and month<10 else 2026,month,day).isoformat()
                a,b=convert(ends[0]),convert(ends[-1])
                for d in days(max(a,START),min(b,END)):
                    if freq!='Daily' and str(date.fromisoformat(d).isoweekday()) not in freq:continue
                    dep,arr=local(d,dc,origin),local(d,ac,target)
                    if arr<=dep:arr+=timedelta(days=1)
                    add(record(code,n,origin,target,dep,arr,src,file,index))
    elif code=='NU':
        file=Path('data/source-samples/crawler/new-airlines-20261014/jta-browser-schedule.json');data=load(file)
        baseline=load(file.parent/'verified-jta/candidate-flights.json')
        assert baseline['records'][0]['evidence']['sha256']==sha(file)
        src=dict(url=data['sourceUrl'],fetchedAt=data['capturedAt'],sha256=sha(file))
        for index,t in enumerate(data['tables']):
            for rowindex,row in enumerate(t['rows']):
                if row[0] not in ('NU301','NU307'):continue
                assert row[1]=='From Okinawa (Naha) To Taipei (Taoyuan)'
                for d in days(START,END):
                    if int(d>='2026-10-25')!=index:continue
                    if index==0 and row[0]=='NU307' and d!='2026-10-24':continue
                    if index==1:assert row[4]=='Daily'
                    dc=re.match(r'\d{1,2}:\d{2}',row[2])[0].zfill(5);ac=re.match(r'\d{1,2}:\d{2}',row[3])[0].zfill(5)
                    dep=local(d,dc,'OKA')
                    if index==1 and row[0]=='NU301' and d>='2026-12-01':
                        assert 'advanced by 5 minutes from December 1 to January 31' in row[2];dep-=timedelta(minutes=5)
                    add(record(code,row[0],'OKA','TPE',dep,local(d,ac,'TPE'),src,file,rowindex,sourceFreshness='latest_access_denied_using_preserved_evidence',tableIndex=index))
                    cells.add(('OKA','TPE',d))
    output=ROOT/'verified'/(code+'-latest' if latest else code);output.mkdir(parents=True,exist_ok=True)
    records=sorted(rows.values(),key=lambda r:(r['date'],r['departure'],r['number']))
    target=output/'candidate-flights.json'
    if target.exists():
        old=load(target)['records']; oldmap={(r['date'],r['number'],r['departureAirport'],r['arrivalAirport']):r for r in records}
        assert all(oldmap.get((r['date'],r['number'],r['departureAirport'],r['arrivalAirport']))==r for r in old),'Previously saved verified record changed'
    target.write_text(json.dumps(dict(records=records,integratedIntoWebsite=False),ensure_ascii=False,indent=2),encoding='utf8')
    audit=dict(airlineCode=code,records=len(records),routes=dict(Counter(r['departureAirport']+'-'+r['arrivalAirport'] for r in records)),countries=dict(Counter(r['countryCode'] for r in records)),duplicateIdentities=0,pending=len(pending),coveredDateRouteCells=len(cells),integratedIntoWebsite=False,sha256=sha(target))
    for name,value in [('audit.json',audit),('pending.json',pending),('coverage.json',sorted(cells))]:
        (output/name).write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(audit,ensure_ascii=False))
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('airlines',nargs='+');parser.add_argument('--latest',action='store_true');args=parser.parse_args()
    for code in args.airlines:collect(code,args.latest)
