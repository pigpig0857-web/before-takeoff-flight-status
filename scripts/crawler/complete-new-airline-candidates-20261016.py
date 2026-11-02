"""Offline completion and evidence audit; never writes production flight data."""
import datetime as dt
import hashlib
import importlib.util
import json
import re
from collections import Counter
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path('data/source-samples/crawler/airline-completeness-20261016')
PRIOR = Path('data/source-samples/crawler/new-airlines-20261016')
START, END = dt.date(2026, 10, 16), dt.date(2026, 12, 31)
DAYS = [START + dt.timedelta(days=i) for i in range((END-START).days+1)]
spec = importlib.util.spec_from_file_location('kixparser','scripts/crawler/parse-kix-schedule-evidence.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
directory = {r['code']:r for r in json.loads(Path('src/features/flights/data/airport-directory.json').read_text(encoding='utf-8'))}
names = {'7G':'星悅航空','HB':'大灣區航空','CI':'中華航空','AK':'馬來西亞亞洲航空','SL':'泰國獅子航空','VZ':'泰國越捷航空','BR':'長榮航空'}


def read(file):
    return json.loads(file.read_text(encoding='utf-8-sig'))


def save(file, value):
    path=ROOT/file
    path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists():
        existing=read(path)
        if file=='differences.json':
            # Identity order is irrelevant; preserve the first saved evidence order.
            existing=dict(existing,changed=sorted(existing['changed'],key=lambda r:r['identity']))
            value=dict(value,changed=sorted(value['changed'],key=lambda r:r['identity']))
        assert existing==value, f'Saved output differs; preserve prior version: {path}'
        return
    with path.open('x',encoding='utf-8') as stream:
        json.dump(value,stream,ensure_ascii=False,indent=2)


def check_proof(proof):
    file=Path(proof['file'])
    raw=file.read_bytes()
    assert hashlib.sha256(raw).hexdigest()==proof['sha256'], f'Source hash mismatch: {file}'
    receipt=read(file.with_suffix('.receipt.json'))
    assert receipt['status']==200 and receipt['sha256']==proof['sha256']
    assert receipt['url']==proof['sourceUrl'] and receipt['fetchedAt']==proof['fetchedAt']
    return raw


def enrich(row):
    row=dict(row)
    airport=directory[row['airport']]
    assert airport['countryCode']==row['countryCode']
    assert directory[row['origin']]['countryCode']=='TW'
    dep=dt.datetime.fromisoformat(row['departure'])
    arr=dt.datetime.fromisoformat(row['arrival'])
    assert dep.astimezone(ZoneInfo('Asia/Taipei')).date().isoformat()==row['date']
    assert dep.utcoffset()==dt.timedelta(hours=8)
    assert arr.astimezone(ZoneInfo(row['arrivalTimeZone'])).isoformat()==row['arrival']
    assert (arr.astimezone(dt.timezone.utc)-dep.astimezone(dt.timezone.utc)).total_seconds()==row['minutes']*60
    assert 0<row['minutes']<1440
    row.update(destinationEnglish=airport['municipality'],originTimeZone='Asia/Taipei',
        destinationCountry='香港' if row['countryCode']=='HK' else '日本',
        airportName=airport['name'],originName=directory[row['origin']]['name'],
        operatingAirline=None,operatingNumber=None,codeshare=None,
        scheduledOnly=True,integratedIntoWebsite=False)
    row['sourceUrl']=row['evidence']['sourceUrl']
    row['fetchedAt']=row['evidence']['fetchedAt']
    row['sourceKind']='airline_published_html' if row['airlineCode']=='7G' else 'airline_published_json' if row['airlineCode']=='HB' else 'airport_published_oag'
    row['sourceNotice']='預定班表可能異動；不是即時動態、可售座位或實際執飛保證。'
    assert all(row[k] for k in ['airlineCode','airline','number','date','origin','airport','countryCode','destination','departure','arrival','arrivalTimeZone','sourceUrl','fetchedAt','evidence'])
    return row


# Complete the two already collected airline sources without repeating requests.
sf=read(PRIOR/'starflyer-candidates.json')
hb=read(PRIOR/'greaterbay-candidates.json')
sf_rows=[enrich(r) for r in sf['records']]
sf_html=check_proof(sf_rows[0]['evidence']).decode('utf-8')
campaign=check_proof(sf['comparisonSource']).decode('utf-8')
assert '運航日：星期一・星期四・星期六' in sf_html and '運航日：星期一・星期四・星期六' in campaign
assert len(sf_rows)==33 and {r['date'] for r in sf_rows}=={str(d) for d in DAYS if d.weekday() in [0,3,5]}
for row in sf_rows:
    assert row['origin']=='TPE' and row['airport']=='KKJ' and row['number']=='7G800'
    assert row['departure'][11:16]=='03:00'
    assert row['arrival'][11:16]==('06:20' if row['date']<'2026-10-25' else '06:15')
    assert row['minutes']==(140 if row['date']<'2026-10-25' else 135)
save('airlines/7G.json',{'records':sf_rows,'rules':sf['rules'],'ruleCrossCheck':sf['comparisonSource'],'coreDataStatus':'complete_for_published_TPE_KKJ_route'})

hb_rows=[enrich(r) for r in hb['records']]
hb_source=json.loads(check_proof(hb_rows[0]['evidence']))
raw_selected=[(i,r['FlightSchedule']) for i,r in enumerate(hb_source) if 'FlightSchedule' in r and r['FlightSchedule']['Origin']=='TPE' and str(START)<=r['FlightSchedule']['FlightDate']<=str(END)]
assert len(raw_selected)==len(hb_rows)==123
assert {r['date'] for r in hb_rows}=={str(d) for d in DAYS}
for row in hb_rows:
    raw=hb_source[row['evidence']['rowIndex']]['FlightSchedule']
    assert raw['FlightNo']==row['number'] and raw['Origin']==row['origin'] and raw['Destination']==row['airport'] and raw['FlightDate']==row['date']
    assert row['departure'][11:16].replace(':','')==raw['ETD'] and row['arrival'][11:16].replace(':','')==raw['ETA']
    assert row['aircraft'] is None and row['aircraftSourceCode']==raw['ACType']
overnight=[r for r in hb_rows if r['arrival'][:10]!=r['date']]
assert len(overnight)==1 and overnight[0]['number']=='HB705' and overnight[0]['departure'].startswith('2026-10-16T23:35') and overnight[0]['arrival'].startswith('2026-10-17T01:35')
save('airlines/HB.json',{'records':hb_rows,'coreDataStatus':'complete_for_published_TPE_HKG_route','sourceStatus':hb['sourceStatus'],'arrivalDateConvention':hb['rolloverEvidence']})

collection=read(ROOT/'collection-progress.json')
if collection['state']!='completed':
    print(json.dumps({'state':'airline_sources_completed_waiting_for_airport_collection','7G':33,'HB':123,'airportCompleted':len(collection['completed']),'airportExpected':154}))
    raise SystemExit(0)
assert not collection['pending']
expected={f'{origin}-{day}' for origin in ['TPE','KHH'] for day in DAYS}
assert set(collection['completed'])==expected


def parse_airport(item):
    file=Path(item['file'])
    receipt=read(file.with_suffix('.receipt.json'))
    proof={'file':file.as_posix(),'sha256':item['sha256'],'sourceUrl':receipt['url'],'fetchedAt':receipt['fetchedAt']}
    raw=check_proof(proof)
    response=json.loads(raw)
    html=next(x['data'] for x in response if x.get('command')=='insert' and x.get('selector')=='#flight-results-wrapper')
    date,origin=dt.date.fromisoformat(item['date']),item['origin']
    assert set(re.findall(r'outboundDate=(\d{4}-\d{2}-\d{2})',html))=={str(date)}
    parser=module.Parser();parser.feed(html)
    result=[]
    targets=['CI','AK','BR'] if origin=='KHH' else ['CI','AK','SL','VZ']
    for index,card in enumerate(parser.root.find_all('flight-card-schedule')):
        code=card.attrs.get('data-flight-airline')
        if card.attrs.get('data-flight-type')!='direct' or code not in targets:continue
        def text(cls):
            nodes=card.find_all(cls)
            assert nodes, f'Core source element missing: {cls}'
            return ' '.join(nodes[0].text().split())
        route=text('flight-card-port-name')
        assert f'({origin})' in route and '(KIX)' in route and route.index(f'({origin})')<route.index('(KIX)')
        identity=re.match(r'([A-Z0-9]{2}\d+)\s*/\s*(.+)',text('flight-card-port-code'))
        assert identity and identity[1].startswith(code)
        departure,arrival=text('flight-card-time-dep'),text('flight-card-time-arr')
        duration=re.fullmatch(r'(\d+)h\s*(\d+)m',text('flight-card-time-pass'))
        assert re.fullmatch(r'\d{2}:\d{2}',departure) and duration
        minutes=int(duration[1])*60+int(duration[2])
        dep=dt.datetime.fromisoformat(f'{date}T{departure}:00').replace(tzinfo=ZoneInfo('Asia/Taipei'))
        arr=(dep.astimezone(dt.timezone.utc)+dt.timedelta(minutes=minutes)).astimezone(ZoneInfo('Asia/Tokyo'))
        assert re.search(r'\d{2}:\d{2}',arrival).group()==arr.strftime('%H:%M')
        offset=re.search(r'\+(\d+)',arrival)
        if offset:assert (arr.date()-date).days==int(offset[1])
        row=dict(origin=origin,airlineCode=code,airline=names[code],number=identity[1],date=str(date),airport='KIX',countryCode='JP',destination='大阪關西',
            departure=dep.isoformat(),arrival=arr.isoformat(),arrivalTimeZone='Asia/Tokyo',minutes=minutes,
            terminal=None,arrivalTerminal=None,aircraft=None,sourceLabel='關西機場公開預定班表（OAG）',
            evidence={**proof,'cardIndex':index,'query':{'from':origin,'to':'KIX','date':str(date)}},
            arrivalDateBasis='published_duration_and_local_clock',primaryAirlineLabel=identity[2])
        result.append(enrich(row))
    return result


airport_rows=[]
coverage=[]
for key in sorted(collection['completed']):
    item=collection['completed'][key]
    rows=parse_airport(item)
    airport_rows+=rows
    for code in (['CI','AK','BR'] if item['origin']=='KHH' else ['CI','AK','SL','VZ']):
        selected=[r for r in rows if r['airlineCode']==code]
        coverage.append({'origin':item['origin'],'airport':'KIX','airlineCode':code,'date':item['date'],'state':'published_flights_saved' if selected else 'source_has_no_matching_primary_flight',
            'records':len(selected),'numbers':[r['number'] for r in selected],'evidenceFile':item['file'],'doesNotProveActualCancellation':True})

all_rows=sorted(sf_rows+hb_rows+airport_rows,key=lambda r:(r['origin'],r['date'],r['departure'],r['number']))
def key(row):return row['origin'],row['date'],row['number'],row['airport']
assert len({key(r) for r in all_rows})==len(all_rows)
for code in ['CI','AK','SL','VZ','BR']:
    rows=[r for r in all_rows if r['airlineCode']==code]
    save(f'airlines/{code}.json',{'records':rows,'coreDataStatus':'complete_for_saved_airport_route_queries_only','otherDestinationsNotCollected':True,'attribution':'Kansai Airports published schedule supplied by OAG'})
for month in ['2026-10','2026-11','2026-12']:
    save(f'months/{month}.json',{'records':[r for r in all_rows if r['date'].startswith(month)],'integratedIntoWebsite':False})
save('candidate-flights.json',{'records':all_rows,'from':str(START),'through':str(END),'integratedIntoWebsite':False})
save('coverage.json',{'airportDateGroups':154,'airlineRouteDateGroups':len(coverage),'groups':coverage,'scope':'specified routes only; not a complete airline network'})

prior=[]
for file in ['starflyer-candidates.json','greaterbay-candidates.json','khh-kix-sample-candidates.json','tpe-kix-reused-candidates.json']:prior+=read(PRIOR/file)['records']
old={key(r):r for r in prior};new={key(r):r for r in all_rows}
changes=[]
for identity in old.keys()&new.keys():
    a,b=old[identity],new[identity]
    fields={k:{'previous':a[k],'current':b[k]} for k in ['departure','arrival','minutes'] if a[k]!=b[k]}
    if fields:changes.append({'identity':list(identity),'fields':fields,'previousEvidence':a['evidence'],'currentEvidence':b['evidence']})
save('differences.json',{'changed':changes,'added':[new[k] for k in sorted(new.keys()-old.keys())],'notListed':[old[k] for k in sorted(old.keys()-new.keys())],
    'originalWebsiteDataModified':False,'previousCandidateDataModified':False})
hashes=read(ROOT/'protected-hashes.json')
assert all(hashlib.sha256(Path(file).read_bytes()).hexdigest()==digest for file,digest in hashes.items())
sources={r['evidence']['file']:r['evidence']['sha256'] for r in all_rows}
assert all(hashlib.sha256(Path(file).read_bytes()).hexdigest()==digest for file,digest in sources.items())
summary=[]
for origin,code,airport in sorted({(r['origin'],r['airlineCode'],r['airport']) for r in all_rows}):
    rows=[r for r in all_rows if (r['origin'],r['airlineCode'],r['airport'])==(origin,code,airport)]
    summary.append({'origin':origin,'airlineCode':code,'airport':airport,'records':len(rows),'publishedDepartureDates':len({r['date'] for r in rows}),'dateScopeCovered':77,
        'months':dict(Counter(r['date'][:7] for r in rows)),'unknownMetadataRetained':True})
audit={'state':'data_completion_finished_for_researched_routes','from':str(START),'through':str(END),'records':len(all_rows),'byRoute':summary,
    'airportQueries':154,'reusedCurrentDaySuccesses':sum(x['state']=='current_day_success_reused' for x in collection['completed'].values()),
    'newAirportQueries':sum(x['state']=='saved_success' for x in collection['completed'].values()),'airlineRouteDateGroups':len(coverage),
    'duplicateIdentities':0,'missingCoreFields':0,'timeZoneOrDurationErrors':0,'pendingQueries':0,'protectedFilesUnchanged':len(hashes),
    'sourceFilesHashChecked':len(sources),'changedPriorRows':len(changes),'addedPriorRows':len(new.keys()-old.keys()),'notListedPriorRows':len(old.keys()-new.keys()),
    'integratedIntoWebsite':False,'sourceAdaptersAndSiteValidationRemaining':True,'wholeAirlineNetworkCompletenessClaimed':False}
save('audit.json',audit)
print(json.dumps(audit,ensure_ascii=False,indent=2))
