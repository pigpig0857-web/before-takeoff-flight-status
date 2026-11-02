"""Read-only replay of fresh official evidence; save an explicit gap audit."""
import json,hashlib,re,datetime as dt
from pathlib import Path
from zoneinfo import ZoneInfo
root=Path('data/source-samples/crawler/gap-recheck-20261020')
read=lambda p:json.loads(Path(p).read_text(encoding='utf-8'))
def proof(name):
 b=(root/(name+'.body')).read_bytes();r=read(root/(name+'.receipt.json'))
 assert r['status']==200 and hashlib.sha256(b).hexdigest()==r['sha256']
 return json.loads(b),r
raw,receipt=proof('tigerair-refresh')
out=[]
for stem in ['tigerair','kaohsiung']:
 for r in read('src/server/data/'+stem+'-flights.json')['records']:
  out.append(dict(r,departureAirport=r.get('origin','TPE'),arrivalAirport=r['airport']))
inbound=read('src/server/data/return-flights.json')['records']
identity=lambda r:'|'.join([r['date'],r['number'],r['departureAirport'],r['arrivalAirport']])
saved={identity(r):r for r in out+inbound if '2026-10-20'<=r['date']<='2026-12-31'}
routes={('TPE','NGO'),('NGO','TPE'),('KHH','OKA'),('OKA','KHH'),('KHH','CJU'),('CJU','KHH')}
zones={'TPE':'Asia/Taipei','KHH':'Asia/Taipei','NGO':'Asia/Tokyo','OKA':'Asia/Tokyo','CJU':'Asia/Seoul'}
week=['monday','tuesday','wednesday','thursday','friday','saturday','sunday']
expected={};pending=[];sourceConflicts=[]
def periods(text):
 year=None;answer=[]
 for part in re.split('[,、]',text):
  limits=[]
  for token in part.strip().split('-'):
   fields=token.strip().split('/')
   if len(fields)==3:year=int(fields.pop(0))
   assert len(fields)==2 and year
   limits.append(dt.date(year,int(fields[0]),int(fields[1])))
  assert len(limits) in [1,2]
  answer.append((limits[0],limits[-1]))
 return answer
rules=[r for c in raw['data'] for s in c['stationSchedules'] for r in s['schedules']]
for index,r in enumerate(rules):
 pair=(r['origin'],r['destination'])
 if pair not in routes:continue
 assert r['carrierCode']=='IT'
 bounds=periods(r['operationDateSummary'])
 for offset in range(73):
  date=dt.date(2026,10,20)+dt.timedelta(days=offset)
  if not r['daysOfWeek'][week[date.weekday()]] or not any(a<=date<=b for a,b in bounds):continue
  dep=dt.datetime.fromisoformat(str(date)+'T'+r['departureTime']).replace(tzinfo=ZoneInfo(zones[pair[0]]))
  arr=dt.datetime.fromisoformat(str(date+dt.timedelta(days=r['overnight']))+'T'+r['arrivalTime']).replace(tzinfo=ZoneInfo(zones[pair[1]]))
  minutes=int((arr.astimezone(dt.timezone.utc)-dep.astimezone(dt.timezone.utc)).total_seconds()/60)
  key='|'.join([str(date),'IT'+str(int(r['flightNumber'])),*pair])
  value=dict(date=str(date),number='IT'+str(int(r['flightNumber'])),departureAirport=pair[0],arrivalAirport=pair[1],departure=dep.isoformat(),arrival=arr.isoformat(),minutes=minutes,sourceRule=index)
  if minutes!=r['durationInMinutes']:
   pending.append(dict(identity=key,sourceMinutes=r['durationInMinutes'],clockMinutes=minutes,rule=r));continue
  if key in expected and any(expected[key][k]!=value[k] for k in ['departure','arrival','minutes']):sourceConflicts.append(key)
  expected[key]=value
missing=[];changed=[]
for key,r in expected.items():
 if key not in saved:missing.append(r)
 elif any(saved[key][k]!=r[k] for k in ['departure','arrival','minutes']):changed.append(dict(identity=key,source=r,saved=saved[key]))
unexpected=[k for k,r in saved.items() if (r['departureAirport'],r['arrivalAirport']) in routes and r['number'].startswith('IT') and k not in expected]
byRoute={}
for pair in routes:
 rows=[r for r in expected.values() if (r['departureAirport'],r['arrivalAirport'])==pair]
 byRoute['-'.join(pair)]=dict(sourceConfirmed=len(rows),savedMatched=sum(identity(r) in saved for r in rows))
result=dict(scope='2026-10-20..2026-12-31 inclusive; local departure dates',sourceSha256=receipt['sha256'],
 sourceFetchedAt=receipt['fetchedAt'],matched=len(expected)-len(missing)-len(changed),missing=missing,changed=changed,
 unexpectedSaved=unexpected,sourceConflicts=sourceConflicts,pending=pending,byRoute=byRoute,
 conclusion='Counts differ in the official source itself; no missing valid published rows' if not missing and not changed and not unexpected else 'Review required')
(root/'tigerair-gap-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:result[k] for k in ['matched','byRoute','conclusion']}))
assert not missing and not changed and not unexpected and not sourceConflicts
