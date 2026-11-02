"""Validate both directions of saved public VN schedules; no website writes."""
import json,hashlib,csv
from pathlib import Path
from datetime import datetime,timedelta,timezone
from zoneinfo import ZoneInfo
from collections import Counter
root=Path('data/source-samples/crawler/khh-expansion-20261020/vietnam')
load=lambda p:json.loads(p.read_text(encoding='utf-8-sig'))
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
plan=load(root/'plan.json');progress=load(root/'progress.json')
zones={'KHH':'Asia/Taipei','HAN':'Asia/Ho_Chi_Minh','SGN':'Asia/Ho_Chi_Minh'}
rows={};conflicts=[];excluded=Counter();coverage=[];same=0
for query in plan:
    if query['id'] not in progress['completed']:continue
    file=root/(query['id']+'.body');receipt=load(root/(query['id']+'.receipt.json'))
    assert receipt['status']==200 and receipt['sha256']==sha(file) and receipt['url']==query['url']
    response=load(file);assert response['success'] is True
    items=response['data']['departureFlight']['scheduleItems']
    selected=0
    for index,item in enumerate(items):
        segments=item['connectedFlights']
        if len(segments)!=1:excluded['connecting_itinerary']+=1;continue
        segment=segments[0];info=segment['flightInfo'];a=info['departureLocation'];b=info['arrivalLocation']
        if a['locationCode']!=query['origin'] or b['locationCode']!=query['destination']:excluded['other_route']+=1;continue
        if info['marketingAirlineCode']!='VN' or info['operatingAirlineCode']!='VN' or segment['numberOfStops']!=0:excluded['other_operator_or_stops']+=1;continue
        dep=datetime.fromisoformat(a['dateTime']).replace(tzinfo=timezone(timedelta(hours=a['dateTimeZoneGmtOffset'])))
        arr=datetime.fromisoformat(b['dateTime']).replace(tzinfo=timezone(timedelta(hours=b['dateTimeZoneGmtOffset'])))
        if dep.date().isoformat()!=query['date']:excluded['other_date']+=1;continue
        assert dep.astimezone(ZoneInfo(zones[query['origin']])).isoformat()==dep.isoformat()
        assert arr.astimezone(ZoneInfo(zones[query['destination']])).isoformat()==arr.isoformat()
        assert dep.strftime('%A').lower() in segment['operatingDays']
        assert segment['validityPeriod']['start'][:10]<=query['date']<=segment['validityPeriod']['end'][:10]
        minutes=int((arr-dep).total_seconds()/60);assert minutes==info['duration']/60 and 30<=minutes<=600
        number='VN'+str(int(info['marketingFlightNumber']))
        r=dict(date=query['date'],airlineCode='VN',airline='越南航空',number=number,departureAirport=query['origin'],arrivalAirport=query['destination'],
            departure=dep.isoformat(),arrival=arr.isoformat(),departureTimeZone=zones[query['origin']],arrivalTimeZone=zones[query['destination']],
            minutes=minutes,arrivalDayOffset=(arr.date()-dep.date()).days,url=receipt['url'],fetchedAt=receipt['fetchedAt'],sourceSha256=receipt['sha256'],
            evidence=dict(file=str(file),itemIndex=index),countryCode='VN',status='published_schedule')
        key=(r['date'],number,r['departureAirport'],r['arrivalAirport'])
        if key in rows:
            if any(rows[key][k]!=r[k] for k in ['departure','arrival','minutes']):conflicts.append(dict(saved=rows[key],candidate=r))
            else:same+=1
        else:rows[key]=r
        selected+=1
    coverage.append(dict(id=query['id'],date=query['date'],origin=query['origin'],destination=query['destination'],directObservations=selected))
records=sorted(rows.values(),key=lambda r:(r['date'],r['departureAirport'],r['number']))
out=root/'verified';out.mkdir(exist_ok=True)
for name,data in [('candidate-flights.json',dict(records=records,integratedIntoWebsite=False)),('conflicts.json',conflicts),('coverage.json',coverage)]:
    (out/name).write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf8')
summary=dict(status='passed' if not conflicts else 'conflicts',records=len(records),outbound=sum(r['departureAirport']=='KHH' for r in records),inbound=sum(r['arrivalAirport']=='KHH' for r in records),
    routes=dict(Counter(r['departureAirport']+'-'+r['arrivalAirport'] for r in records)),queriesCompleted=len(coverage),queriesPlanned=len(plan),
    emptyDirectQueries=sum(not c['directObservations'] for c in coverage),duplicateObservationsMerged=same,duplicateIdentities=0,conflicts=len(conflicts),excluded=dict(excluded),
    sourceState=progress['state'],candidateSha256=sha(out/'candidate-flights.json'),websiteImported=False)
(out/'audit.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(summary,ensure_ascii=False))
