"""Validate alternative public evidence without changing website snapshots or booking progress."""
import json,sys,hashlib
from pathlib import Path
from datetime import datetime,date
from collections import Counter

root=Path(sys.argv[1]).resolve()
workspace=Path(__file__).resolve().parents[2]
assert root.parent==(workspace/'data/source-samples/crawler').resolve()
def read(p):return json.loads(Path(p).read_text(encoding='utf8'))
def key(r):return r['date'],r['airport'],'MM'+str(int(r['number'][2:]))
snapshot=read(workspace/'src/server/data/peach-flights.json')
booking=read(workspace/'src/server/data/peach-booking-checks.json')
progress=read(workspace/'src/server/data/peach-verification-progress.json')
saved={key(r):r for r in snapshot['records']}
completed={key(r):r for r in booking['records']}
live=read(root/'peach-live.json')
assert live['code']=='000'
receipts=read(root/'airport-receipt.json')
receipt=next(r for r in receipts['sources'] if r['file']=='peach-live.json')
assert hashlib.sha256((root/'peach-live.json').read_bytes()).hexdigest()==receipt['sha256']
checks=[];differences=[]
for r in live['flights']:
    if r['origin']!='TPE' or not ('2026-10-12'<=r['flight_date']<='2026-12-31'):continue
    out={'date':r['flight_date'],'airport':r['destination'],'number':r['flight_number'],
         'departure':r['std'].replace(' ','T')+':00+08:00','arrival':r['sta'].replace(' ','T')+':00+09:00',
         'aircraftCode':r['equipment'],'departureGate':r['slot_org'],'arrivalGate':r['slot_des'],
         'fetchedAt':receipt['finishedAt'],'url':receipt['url'],'source':'peach_official_live',
         'evidenceSha256':receipt['sha256'],'sourceCurrentDateTime':live['current_datetime']}
    saved_row=saved.get(key(out))
    if not saved_row:differences.append({'identity':key(out),'reason':'not_in_saved_schedule'});continue
    mismatches=[field for field in ['departure','arrival'] if datetime.fromisoformat(out[field])!=datetime.fromisoformat(saved_row[field])]
    if mismatches:
        differences.append({'identity':key(out),'fields':mismatches,'sourceArrival':out['arrival'],'savedArrival':saved_row['arrival']})
        out['verificationState']='requires_review'
    else:out['verificationState']='scheduled_times_match'
    out['scheduledTimesMatch']=not mismatches
    out['previousBookingCheckExists']=key(out) in completed
    checks.append(out)
assert len(set(key(r) for r in checks))==len(checks)
assert all(d['fields']==['arrival'] and d['identity'][1:] == ('HND','MM860') for d in differences),differences
(root/'peach-live-checks.json').write_text(json.dumps({'version':1,'scope':'Official near-date observations only; never propagated to other dates','records':checks},ensure_ascii=False,indent=2),encoding='utf8')
n=read(root/'naha-arrivals.json');nr=read(root/'naha-date-range.json')
npeach=[r for r in n.get('TPE',{}).get('data',[]) if r['carrierFsCode']=='MM']
h=read(root/'haneda-month-arrivals.json')
hpeach=[r for r in h['flight_info'] if r.get('出発地空港コード')=='TPE' and any(a['ＡＬコード']=='APJ' for a in r['航空会社'])]
airport_rows={'naha':{'range':nr,'peachTaipeiRules':npeach},'haneda':{'lastUpdated':h['last_upd'],'sourceWindowStart':h['start'],'sourceWindowEnd':h['end'],'peachTaipeiRules':hpeach}}
(root/'airport-rule-evidence.json').write_text(json.dumps(airport_rows,ensure_ascii=False,indent=2),encoding='utf8')
report={'checkedAt':datetime.now().astimezone().isoformat(),'liveSourceAllFlights':len(live['flights']),
        'liveSourceDates':sorted(set(r['flight_date'] for r in live['flights'])),
        'liveTpeObserved':len(checks),'scheduledTimesMatched':sum(r['scheduledTimesMatch'] for r in checks),'requiresReview':sum(not r['scheduledTimesMatch'] for r in checks),'byDepartureDate':dict(Counter(r['date'] for r in checks)),
        'newDatedAircraftEvidenceBeyondBookingChecks':sum(not r['previousBookingCheckExists'] for r in checks),
        'sourceAircraftCodes':dict(Counter(r['aircraftCode'] for r in checks)),
        'scheduleDifferences':differences,
        'naha':{'range':nr,'peachTaipeiRules':len(npeach),'hasAircraftField':any('aircraft' in k.lower() for r in npeach for k in r)},
        'haneda':{'sourceWindowEnd':h['end'],'peachTaipeiRules':len(hpeach),'rulePeriods':[{'start':r['運航開始日'],'end':r['運航終了日'],'arrival':r['ＳＴＡ']} for r in hpeach]},
        'bookingVerifiedStill':len(booking['records']),'bookingProgressSummary':progress['summary'],
        'integratedIntoWebsite':False,'allYearEndDetailedFlightsVerified':False}
(root/'alternative-data-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(report,ensure_ascii=False,indent=2))
