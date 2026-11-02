"""Plan reverse queries only for the website's active published outbound routes."""
import json
import hashlib
from collections import Counter
from datetime import date,timedelta
from pathlib import Path

root=Path('data/source-samples/crawler/return-world-20261019')
root.mkdir(exist_ok=True)
load=lambda p:json.loads(p.read_text(encoding='utf-8-sig'))
codes={'BR','MM','IT','JX','7C','VN','NU','GK','PR'}
routes={}
for file in Path('src/server/data').glob('*flights.json'):
    if file.name=='return-flights.json':continue
    for r in load(file).get('records',[]):
        code=r.get('airlineCode') or r['number'][:2]
        if code not in codes or not '2026-10-19'<=r['date']<='2026-12-31':continue
        home=r.get('origin') or ('KHH' if file.name.startswith('kaohsiung') else 'TPE')
        airport=r.get('airport')
        if home not in ('TPE','KHH') or not airport:continue
        key=(code,airport,home)
        routes[key]=dict(airlineCode=code,origin=airport,destination=home,countryCode=r.get('countryCode'))
inventory=list(routes.values())
(root/'outbound-route-inventory.json').write_text(json.dumps(inventory,ensure_ascii=False,indent=2),encoding='utf8')
protected={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in Path('src/server/data').glob('*.json')}
pin=root/'website-before.json'
if not pin.exists():pin.write_text(json.dumps(protected,indent=2),encoding='utf8')
requests=[]
for r in inventory:
    if r['airlineCode']!='7C':continue
    for i in range(11):
        center=date(2026,10,22)+timedelta(days=7*i)
        requests.append(dict(id=f"jeju-{r['origin'].lower()}-{r['destination'].lower()}-{center}",url='https://www.jejuair.net/en/prepare/flight/getFlightSchedule.json',body=dict(startDate=str(center).replace('-',''),endDate='',depStn=r['origin'],arrStn=r['destination'],cultureCode='en-US')))
(root/'jeju-plan.json').write_text(json.dumps(dict(requests=requests),indent=2),encoding='utf8')
requests=[]
for r in inventory:
    if r['airlineCode']!='VN':continue
    requests.append(dict(id=f"vn-{r['origin'].lower()}-{r['destination'].lower()}-2026-11-10",url=f"https://integration-middleware-website.vietnamairlines.com/api/v1/public/flight/schedule-table?originLocationCode={r['origin']}&destinationLocationCode={r['destination']}&departureDate=2026-11-10"))
(root/'vn-probe-plan.json').write_text(json.dumps(dict(requests=requests[:1]),indent=2),encoding='utf8')
daily=[]
for r in inventory:
    if r['airlineCode']!='VN':continue
    for i in range(74):
        day=date(2026,10,19)+timedelta(days=i)
        daily.append(dict(id=f"vn-{r['origin'].lower()}-{r['destination'].lower()}-{day}",url=f"https://integration-middleware-website.vietnamairlines.com/api/v1/public/flight/schedule-table?originLocationCode={r['origin']}&destinationLocationCode={r['destination']}&departureDate={day}"))
(root/'vn-daily-plan.json').write_text(json.dumps(dict(requests=daily),indent=2),encoding='utf8')
print(json.dumps(dict(activeAirlines=dict(Counter(r['airlineCode'] for r in inventory)),countries=sorted(set(r['countryCode'] for r in inventory if r['countryCode'])),vietnamDailyQueries=len(daily)),ensure_ascii=False))
