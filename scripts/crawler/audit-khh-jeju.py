"""Independent offline audit of KHH Jeju observations; never imports website data."""
import collections
import datetime as dt
import hashlib
import json
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path('data/source-samples/crawler/khh-jeju-20261016')
read = lambda p: json.loads(Path(p).read_text(encoding='utf-8-sig'))
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
progress = read(ROOT / 'progress.json')
snapshot = read(ROOT / 'candidate-flights.json')
first, last = dt.date(2026, 10, 16), dt.date(2026, 12, 31)
dates = [(first + dt.timedelta(days=n)).isoformat() for n in range((last-first).days+1)]
expected_cells = {(airport, date) for airport in ['GMP', 'PUS'] for date in dates}
raw_rows, cells, observations = {}, set(), []
sources = set()

def validate_source(file):
    file = Path(file)
    receipt = read(str(file).replace('.body', '.receipt.json'))
    assert receipt['status'] == 200 and sha(file) == receipt['sha256']
    assert dt.datetime.fromisoformat(receipt['fetchedAt'].replace('Z','+00:00')).astimezone(ZoneInfo('Asia/Taipei')).date() == first
    return receipt, read(file)

station_receipt, stations = validate_source(ROOT/'khh-direct-stations.body')
assert station_receipt['url'] == 'https://sec.jejuair.net/en/ibe/booking/selectArrivalStations.json'
assert stations['code'] == '0000'
direct = [r for r in stations['data']['data']['stations'] if r.get('mac') != 'Y' and r['connectYn'] == 'N']
assert {r['stationCode'] for r in direct} == {'GMP', 'PUS'}
assert all(r['countryCode'] == 'KR' and r['differenceTime'] == '+09:00' for r in direct)

for source in progress['sourceResponses']:
    receipt, response = validate_source(source['file'])
    assert receipt['url'] == 'https://www.jejuair.net/en/prepare/flight/getFlightSchedule.json'
    assert source['sha256'] == receipt['sha256'] and source['fetchedAt'] == receipt['fetchedAt']
    query, airport = dt.date.fromisoformat(source['date']), source['airport']
    assert response['code'] == '0000' and isinstance(response['data']['dep'],list)
    low, high = query-dt.timedelta(days=3), query+dt.timedelta(days=3)
    for n in range(7):
        date = low + dt.timedelta(days=n)
        if first <= date <= last: cells.add((airport,date.isoformat()))
    for index,item in enumerate(response['data']['dep']):
        designator, leg, identifier = item['designator'], item['legDetails'], item['identifier']
        assert designator['origin'] == 'KHH' and designator['destination'] == airport
        assert identifier['carrierCode'] == '7C' and leg['codeShareIndicator'] == 'NonCodeShare'
        assert leg['status'] in ['Normal','Closed']
        departure = dt.datetime.fromisoformat(leg['departureTimeUtc'].replace('Z','+00:00')).astimezone(ZoneInfo('Asia/Taipei'))
        arrival = dt.datetime.fromisoformat(leg['arrivalTimeUtc'].replace('Z','+00:00')).astimezone(ZoneInfo('Asia/Seoul'))
        assert departure.replace(tzinfo=None).isoformat() == designator['departure']
        assert arrival.replace(tzinfo=None).isoformat() == designator['arrival']
        assert low <= departure.date() <= high
        if not first <= departure.date() <= last: continue
        number = '7C'+identifier['identifier'];key=(departure.date().isoformat(),number,airport)
        row={'date':key[0],'number':number,'airport':airport,'departure':departure.isoformat(),'arrival':arrival.isoformat(),'minutes':(arrival-departure).total_seconds()/60}
        if key in raw_rows: assert raw_rows[key] == row,(key,'conflicting observations')
        else:raw_rows[key]=row
        observations.append((key,source['file'],index))
    sources.add(source['file'])

assert cells == expected_cells
assert progress['uncovered'] == [] and progress['conflicts'] == []
assert progress['coveredCells'] == len(cells) == 154
rows=snapshot['records']; keys=[(r['date'],r['number'],r['airport']) for r in rows]
assert len(keys) == len(set(keys)) == len(raw_rows) == 110
assert set(keys) == set(raw_rows)
for r in rows:
    key=(r['date'],r['number'],r['airport']);raw=raw_rows[key]
    for field in ['date','number','airport','departure','arrival','minutes']: assert r[field]==raw[field],(key,field)
    for field in ['terminal','arrivalTerminal','aircraft','candidateAirport','operatingNumber']: assert r[field] is None
    assert r['origin']=='KHH' and r['countryCode']=='KR' and r['arrivalTimeZone']=='Asia/Seoul'
    assert r['airline']==r['operatingAirline']=='濟州航空' and r['codeshare'] is False
    e=r['evidence'];assert (key,e['file'],e['rowIndex']) in observations
    receipt,_=validate_source(e['file']);assert r['fetchedAt']==receipt['fetchedAt'] and e['sha256']==receipt['sha256']
    assert e['query']['origin']=='KHH' and e['query']['airport']==r['airport']
    assert r['url']=='https://www.jejuair.net/en/prepare/flight/viewScheduleInfo.do'
for file,digest in progress['catalogueHashes'].items():assert sha(file)==digest,file

airport_rows={airport:[r for r in rows if r['airport']==airport] for airport in ['GMP','PUS']}
no_flights={airport:[date for date in dates if not any(r['date']==date for r in airport_rows[airport])] for airport in airport_rows}
audit={'state':'passed','auditedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'origin':'KHH','from':first.isoformat(),'through':last.isoformat(),
       'records':len(rows),'byAirport':{a:len(r) for a,r in airport_rows.items()},'byMonth':dict(collections.Counter(r['date'][:7] for r in rows)),
       'byNumber':dict(collections.Counter(r['number'] for r in rows)), 'requiredDateAirportCells':154,'checkedDateAirportCells':len(cells),
       'queryResponses':len(sources),'reusedSuccessfulSampleResponses':6,'duplicates':0,'conflictingObservations':0,'missingCoreFields':0,
       'localUTCAndIANAZoneAgreement':True,'officialDirectDestinationInventoryComplete':True,'successfulNoDepartureDates':no_flights,
       'allSourceHashesMatch':True,'originalCatalogueFilesUnchanged':len(progress['catalogueHashes']),'websiteImported':False,
       'unknownFields':['aircraft','departureTerminal','arrivalTerminal','counter','gate'],'verificationMeaning':'All published weekly source cells checked; not a guarantee of future operation or real-time availability'}
(ROOT/'audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({k:v for k,v in audit.items() if k!='successfulNoDepartureDates'},ensure_ascii=False))
