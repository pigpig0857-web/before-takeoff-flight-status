"""Replay saved official airport evidence; never query or extrapolate beyond its scope."""
import json, hashlib, datetime as dt
from pathlib import Path
ROOT=Path('data/source-samples/crawler/thai-lion-20261020')
if (ROOT/'integration/import.json').exists():
    raise SystemExit('Already integrated: keep saved progress and do not restage imported records.')
def read(p):return json.loads(Path(p).read_text(encoding='utf-8'))
def save(name,value):(ROOT/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def source(stem):
    p=Path(stem+'.body');b=p.read_bytes();r=read(stem+'.receipt.json')
    assert r['status']==200 and hashlib.sha256(b).hexdigest()==r['sha256']
    return json.loads(b),r,str(p)
zones={'TPE':('Asia/Taipei','+08:00'),'KHH':('Asia/Taipei','+08:00'),'CTS':('Asia/Tokyo','+09:00'),'OKA':('Asia/Tokyo','+09:00'),'DMK':('Asia/Bangkok','+07:00')}
observed=[]
def add(date,number,origin,destination,dep,arr,day,r,file,index,note=''):
    if not '2026-10-20'<=date<='2026-12-31':return
    assert (origin in ('TPE','KHH')) != (destination in ('TPE','KHH'))
    depiso=f'{date}T{dep}:00{zones[origin][1]}'
    arrdate=(dt.date.fromisoformat(date)+dt.timedelta(days=day)).isoformat()
    arriso=f'{arrdate}T{arr}:00{zones[destination][1]}'
    minutes=int((dt.datetime.fromisoformat(arriso)-dt.datetime.fromisoformat(depiso)).total_seconds()/60)
    assert 0<minutes<1440
    observed.append(dict(date=date,number=number,airlineCode='SL',airline='泰獅航空',departureAirport=origin,arrivalAirport=destination,
        departure=depiso,arrival=arriso,departureTimeZone=zones[origin][0],arrivalTimeZone=zones[destination][0],arrivalDayOffset=day,
        minutes=minutes,url=r['url'],fetchedAt=r['fetchedAt'],sourceSha256=r['sha256'],evidence=dict(file=file,rowIndex=index),
        status='published_schedule',sourceNotice=note))
# Exact dated airport table: split at the published KHH stop, not the Bangkok endpoint.
cts,receipt,file=source('data/source-samples/crawler/cts-khh-20261020/airport-schedule')
for i,row in enumerate(cts['items']):
    if not any(a['Airline_2Cd']=='SL' and a['SharingfltDiv']==0 for a in row['Airline']):continue
    assert len(row['Airline'])==1
    if len(row['Transits'])!=1 or row['Transits'][0]['AreaCode']!='KHH':continue
    stop=row['Transits'][0];assert not stop['NextDayArrival'] and not stop['NextDayDeparture']
    num=row['Airline'][0]['Flight']
    for date in row['ActiveDate']:
        if row['DA']=='A':
            add(date,num,'DMK','KHH',row['DepartureTime'],stop['ArrivalTime'],0,receipt,file,i,'官方機場班表中的曼谷至高雄航段。')
            add(date,num,'KHH','CTS',stop['DepartureTime'],row['ArrivalTime'],0,receipt,file,i,'同班號自曼谷經高雄抵達札幌；此處僅顯示高雄至札幌航段。')
        else:
            add(date,num,'CTS','KHH',row['DepartureTime'],stop['ArrivalTime'],0,receipt,file,i,'同班號後續飛曼谷；此處僅顯示札幌至高雄航段。')
            add(date,num,'KHH','DMK',stop['DepartureTime'],row['ArrivalTime'],int(row['NextDayArrival']),receipt,file,i,'官方機場班表中的高雄至曼谷航段。')
# Reviewed Naha October rows. Weekdays are published rules within the month only.
# Preserve SI source typo; normalize ONLY exact Thai Lion Air name and reviewed row IDs.
rules={
 90065:([0,2,4],{26:('12:10','12:45'),30:('12:10','12:45')}),
 90072:([6],{28:('19:30','20:05'),31:('19:30','20:05')}),
 90098:([1,3,5,6],{27:('14:50','15:40')}),
 90106:([0,2,4],{26:('09:00','11:15'),30:('09:00','11:15')}),
 90181:([2,5,6],{25:('15:40','18:00')}),
 90140:([1,3,5,6],{27:('11:10','13:50')})}
dates,_,_=source(str(ROOT/'oka-dates'))
assert dates=={'start_date':'2026年10月01日','end_date':'2026年10月31日'}
corrections=[]
for name in ['oka-departures','oka-arrivals']:
    data,r,file=source(str(ROOT/name))
    for airport in ['TPE','KHH']:
        for x in data[airport]['data']:
            if x['id'] not in rules:continue
            assert x['carrierFsCode']=='SI' and x['carrierEnglishName']=='Thai Lion Air'
            weekdays,exceptions=rules[x['id']]
            corrections.append(dict(file=file,id=x['id'],sourceCode='SI',normalizedCode='SL',basis='Exact Thai Lion Air name; official NRT and CTS identify SL/TLM',remarks=x['remarks'],englishRemarks=x['en_remarks']))
            for day in range(20,32):
                date=dt.date(2026,10,day)
                if date.weekday() not in weekdays and day not in exceptions:continue
                dep,arr=exceptions.get(day,(x['departureTime'],x['arrivalTime']))
                add(date.isoformat(),'SL'+x['flightNumber'],x['departureAirportFsCode'],x['arrivalAirportFsCode'],dep,arr,0,r,file,x['id'],
                    '那霸機場官方10月班表；來源航空公司名稱為 Thai Lion Air，原始代碼 SI 已依官方航空公司識別統一為 SL。')
# KHH source has a separate validity period and weekday flags; no rolling extrapolation.
kia,r,file=source('data/source-samples/crawler/khh-expansion-20261020/probes/kia')
for i,x in enumerate(kia):
    if x['airLineCode']!='SL':continue
    start=max(x['weekstart'],x['ScheduleStartDate'],'2026-10-20');end=min(x['weekend'],x['ScheduleEndDate'],'2026-12-31')
    date=dt.date.fromisoformat(start)
    while date.isoformat()<=end:
        if x[['MON','TUE','WED','THU','FRI','SAT','SUN'][date.weekday()]]=='Y':
            dep=x['expectDepartureTime'];arr=x['expectArrivalTime'];day=1 if '+1' in arr else 0;arr=arr[:4]
            add(date.isoformat(),x['airLineNum'],x['upAirportCode'],x['goalAirportCode'],dep[:2]+':'+dep[2:4],arr[:2]+':'+arr[2:4],day,r,file,i)
        date+=dt.timedelta(days=1)
def key(r):return '|'.join(r[k] for k in ['date','number','departureAirport','arrivalAirport'])
groups={}
for row in observed:groups.setdefault(key(row),[]).append(row)
existing={key(r):r for r in read('src/server/data/return-flights.json')['records']}
candidates=[];conflicts=[];already=[]
for identity,rows in sorted(groups.items()):
    clocks={(r['departure'],r['arrival']) for r in rows}
    if len(clocks)>1:conflicts.append(dict(identity=identity,observations=rows,existing=existing.get(identity)));continue
    if identity in existing:
        old=existing[identity]
        if (old['departure'],old['arrival'])!=next(iter(clocks)):conflicts.append(dict(identity=identity,observations=rows,existing=old))
        else:already.append(identity)
        continue
    row=rows[0];row['supportingEvidence']=[r['evidence'] for r in rows];candidates.append(row)
save('candidates.json',{'records':candidates});save('conflicts.json',{'records':conflicts});save('code-corrections.json',corrections)
routeCounts={}
for row in candidates:
    route=row['departureAirport']+'-'+row['arrivalAirport'];routeCounts[route]=routeCounts.get(route,0)+1
save('progress.json',dict(state='available_sources_staged',fromDate='2026-10-20',targetThrough='2026-12-31',publishedThrough='2026-10-31',
    observed=len(observed),uniqueObserved=len(groups),newCandidates=len(candidates),existingPreserved=len(already),conflicts=len(conflicts),byRoute=routeCounts,
    pending=['November and December not published by accessible monthly airport sources','TPE-DMK and TPE-NRT need complete segment evidence','TPE-NGO official airport denied access','Lion airline website 403; no bypass or retry','NRT query returns whole destination DMK without TPE segment times; not imported','TPE open data dates are 2025; excluded'],websiteImported=False))
print(json.dumps(read(ROOT/'progress.json'),ensure_ascii=True))
