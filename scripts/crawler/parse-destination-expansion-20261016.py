"""Offline evidence parsing and canonical identity deduplication; no website writes."""
import datetime as dt
import hashlib
import importlib.util
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT=Path('data/source-samples/crawler/destination-expansion-20261016')
PRIOR=Path('data/source-samples/crawler/airline-completeness-20261016')
def read(p): return json.loads(Path(p).read_text(encoding='utf-8-sig'))
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def save(name,data):
    p=ROOT/name;p.parent.mkdir(parents=True,exist_ok=True)
    content=json.dumps(data,ensure_ascii=False,indent=2)+'\n'
    if not p.exists() or p.read_text(encoding='utf-8')!=content:p.write_text(content,encoding='utf-8')
def canonical(number):
    m=re.fullmatch(r'([A-Z0-9]{2})(\d+)([A-Z]?)',str(number).upper().replace(' ',''))
    assert m,number
    return m[1]+str(int(m[2]))+m[3]
def key(r):return r.get('origin','TPE'),r['date'],canonical(r['number']),r['airport']
def instant(s):return dt.datetime.fromisoformat(s.replace('Z','+00:00')).astimezone(dt.timezone.utc)
def same(a,b):return all(instant(a[f])==instant(b[f]) for f in ['departure','arrival'])

protected_file=ROOT/'protected-hashes.json'
if not protected_file.exists():
    protected=read(PRIOR/'protected-hashes.json')
    for p in list(Path('src/server/data').glob('*.json'))+[PRIOR/'candidate-flights.json',PRIOR/'collection-progress.json']:
        protected[p.as_posix()]=sha(p)
    protected_file.write_text(json.dumps(protected,indent=2)+'\n',encoding='utf-8')
protected=read(protected_file)
assert all(sha(f)==h for f,h in protected.items()),'Protected original data changed'

baseline=defaultdict(list)
for p in list(Path('src/server/data').glob('*flights.json'))+[PRIOR/'candidate-flights.json']:
    data=read(p);rows=data.get('records',[]) if isinstance(data,dict) else data
    for index,r in enumerate(rows):
        if not ('2026-10-16'<=r.get('date','')<='2026-12-31'):continue
        if not r.get('airport') or not r.get('number'):continue
        baseline[key(r)].append({'file':p.as_posix(),'index':index,'record':r})

spec=importlib.util.spec_from_file_location('public_parser','scripts/crawler/parse-kix-schedule-evidence.py')
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
directory={r['code']:r for r in read('src/features/flights/data/airport-directory.json')}
zones={'NRT':'Asia/Tokyo','ICN':'Asia/Seoul','HKG':'Asia/Hong_Kong'}
countries={'NRT':('JP','日本','東京成田'),'ICN':('KR','韓國','首爾仁川'),'HKG':('HK','香港','香港')}
public_schedule_page='https://www.kansai-airport.or.jp/tw/flight/schedule'
official_code_names={'FD':('泰國亞洲航空','https://newsroom.airasia.com/news/2026/7/21/thai-airasia-achieves-iosa-certification-cementing-world-class-aviation-safety-standard')}
fd_file=ROOT/'official-fd-airline-code.body'
fd_receipt=read(ROOT/'official-fd-airline-code.receipt.json')
assert fd_receipt['status']==200 and sha(fd_file)==fd_receipt['sha256']
assert re.search(r'Thai AirAsia.{0,100}flight code.{0,20}FD',fd_file.read_text(encoding='utf-8'),re.I)
tw_file=ROOT/'incheon-airline-directory.body'
tw_receipt=read(ROOT/'incheon-airline-directory.receipt.json')
assert tw_receipt['status']==200 and sha(tw_file)==tw_receipt['sha256']
assert re.search(r'Trinity Airways[\s\S]{0,500}IATA\s*:\s*</i>TW',tw_file.read_text(encoding='utf-8'),re.I)
progress=read(ROOT/'collection-progress.json')
observed=defaultdict(list);coverage=[];sources={};skipped=Counter()
for qid,item in sorted(progress['completed'].items()):
    p=Path(item['file']);receipt=read(p.with_suffix('.receipt.json'))
    assert receipt['status']==200 and sha(p)==item['sha256']==receipt['sha256']
    response=read(p);html=next(c['data'] for c in response if c.get('selector')=='#flight-results-wrapper')
    assert set(re.findall(r'outboundDate=(\d{4}-\d{2}-\d{2})',html))=={item['date']}
    parser=mod.Parser();parser.feed(html)
    group=[];origin,to,date=item['from'],item['to'],item['date']
    for index,card in enumerate(parser.root.find_all('flight-card-schedule')):
        if card.attrs.get('data-flight-type')!='direct':skipped['connectingItineraries']+=1;continue
        def text(cls):
            nodes=card.find_all(cls);assert len(nodes)==1,(qid,index,cls,len(nodes))
            return ' '.join(nodes[0].text().split())
        assert re.findall(r'\(([A-Z]{3})\)',text('flight-card-port-name'))==[origin,to]
        raw_identity=text('flight-card-port-code')
        m=re.fullmatch(r'([A-Z0-9]{2}\d+[A-Z]?)(?:\s*/\s*(.+))?',raw_identity)
        assert m,(qid,index,raw_identity)
        code=card.attrs['data-flight-airline'];assert m[1].startswith(code)
        dep_clock=text('flight-card-time-dep');assert re.fullmatch(r'\d{2}:\d{2}',dep_clock)
        assert card.attrs['data-flight-departure']==dep_clock
        dur=re.fullmatch(r'(\d+)h\s*(\d+)m',text('flight-card-time-pass'));assert dur
        minutes=int(dur[1])*60+int(dur[2]);assert 0<minutes<1440
        dep=dt.datetime.fromisoformat(f'{date}T{dep_clock}:00').replace(tzinfo=ZoneInfo('Asia/Taipei'))
        arr=(dep.astimezone(dt.timezone.utc)+dt.timedelta(minutes=minutes)).astimezone(ZoneInfo(zones[to]))
        arr_text=text('flight-card-time-arr');clock=re.search(r'\d{2}:\d{2}',arr_text);assert clock and arr.strftime('%H:%M')==clock[0]
        offset=re.search(r'\+(\d+)',arr_text)
        if offset:assert (arr.date()-dep.date()).days==int(offset[1]),(qid,m[1],arr_text,arr.isoformat())
        country,country_name,city=countries[to]
        assert m[2] or code in official_code_names,(qid,index,raw_identity)
        r={'origin':origin,'date':date,'number':m[1],'canonicalNumber':canonical(m[1]),'airlineCode':code,
           'airline':m[2] or official_code_names[code][0],
           'airlineNameSourceStatus':'published_label' if m[2] else 'official_airline_code_reference',
           'airlineNameReference':None if m[2] else official_code_names[code][1],
           'airlineNameEvidence':None if m[2] else {'file':fd_file.as_posix(),'sha256':fd_receipt['sha256']},
           'airlineNameCrossCheck':{'file':tw_file.as_posix(),'sha256':tw_receipt['sha256'],'officialName':'Trinity Airways'} if code=='TW' else None,
           'airport':to,'destination':city,'destinationEnglish':directory[to]['municipality'],'airportName':directory[to]['name'],
           'originName':directory[origin]['name'],'countryCode':country,'destinationCountry':country_name,
           'departure':dep.isoformat(),'arrival':arr.isoformat(),'originTimeZone':'Asia/Taipei','arrivalTimeZone':zones[to],
           'minutes':minutes,'terminal':None,'arrivalTerminal':None,'aircraft':None,'operatingAirline':None,'operatingNumber':None,
           'codeshare':None,'sourceUrl':public_schedule_page,'fetchedAt':receipt['fetchedAt'],'sourceKind':'airport_published_oag',
           'sourceLabel':'關西機場公開預定班表（OAG）',
           'arrivalDateBasis':'published_day_marker_and_duration' if offset else 'published_duration_and_local_clock',
           'scheduledOnly':True,'integratedIntoWebsite':False,
           'sourceNotice':'僅此六條航線的預定班表；不是完整航空公司航網、即時動態或實際執飛保證。',
           'evidence':{'file':p.as_posix(),'sha256':receipt['sha256'],'sourceUrl':public_schedule_page,'requestUrl':receipt['url'],'fetchedAt':receipt['fetchedAt'],
                       'cardIndex':index,'query':{'from':origin,'to':to,'date':date}}}
        observed[key(r)].append(r);group.append(r)
    assert group,(qid,'No direct primary flight confirmed; pending')
    coverage.append({'id':qid,'origin':origin,'airport':to,'date':date,'primaryCardCount':len(group),'uniqueIdentities':len({key(r) for r in group}),
                     'airlines':sorted({r['airlineCode'] for r in group}),'evidenceFile':p.as_posix()})
    sources[p.as_posix()]=receipt['sha256']

new=[];matches=[];differences=[];repeated=[];source_conflicts=[]
for ident,versions in sorted(observed.items()):
    row=versions[0]
    if any(not same(row,v) for v in versions[1:]):
        source_conflicts.append({'identity':list(ident),'versions':versions});continue
    if len(versions)>1:repeated.append({'identity':list(ident),'occurrences':len(versions),'evidence':[v['evidence'] for v in versions]})
    old=baseline.get(ident,[])
    if not old:new.append(row);continue
    comparison=[{'file':x['file'],'index':x['index'],'departure':x['record']['departure'],'arrival':x['record']['arrival'],
                 'sourceUrl':x['record'].get('sourceUrl',x['record'].get('url')),'sameTimes':same(row,x['record'])} for x in old]
    result={'identity':list(ident),'currentEvidence':row,'existingRecords':comparison,'originalDataModified':False}
    if all(c['sameTimes'] for c in comparison):matches.append(result)
    else:differences.append(result)

assert len({key(r) for r in new})==len(new)
assert not {key(r) for r in new}&set(baseline)
assert len(observed)==len(new)+len(matches)+len(differences)+len(source_conflicts)
save('candidate-flights.json',{'records':new,'integratedIntoWebsite':False,'scope':progress['scope'],'identityRule':'origin + departure date + canonical primary flight number + destination airport'})
save('existing-matches.json',{'records':matches,'notAddedAgain':True})
save('time-differences.json',{'records':differences,'automaticOverwrite':False,'requiresReview':True})
save('source-conflicts.json',{'records':source_conflicts,'repeatedSameTimeCards':repeated})
save('coverage.json',{'groups':coverage,'completed':len(coverage),'expected':progress['expected'],'pending':progress['pending']})
for code in sorted({r['airlineCode'] for r in new}):save(f'airlines/{code}.json',{'records':[r for r in new if r['airlineCode']==code],'integratedIntoWebsite':False})
for month in ['2026-10','2026-11','2026-12']:save(f'months/{month}.json',{'records':[r for r in new if r['date'].startswith(month)],'integratedIntoWebsite':False})
totals={'state':progress['state'],'completedDateGroups':len(coverage),'expectedDateGroups':progress['expected'],
        'uniqueSourceFlights':len(observed),'newUniqueCandidates':len(new),'existingSameTimeFlights':len(matches),
        'existingIdentityTimeDifferences':len(differences),'sourceIdentityConflicts':len(source_conflicts),
        'repeatedSourceCards':sum(r['occurrences']-1 for r in repeated),'candidateDuplicateCount':0,
        'overlapWithBaseline':0,'baselineUniqueIdentities':len(baseline),'protectedFilesUnchanged':len(protected),
        'verifiedSourceFiles':len(sources),'byAirline':dict(sorted(Counter(r['airlineCode'] for r in new).items())),
        'byRoute':dict(sorted(Counter(r['origin']+'-'+r['airport'] for r in new).items())),
        'skipped':dict(skipped),'integratedIntoWebsite':False}
save('audit.json',totals)
assert all(sha(f)==h for f,h in protected.items())
print(json.dumps(totals,ensure_ascii=False))
