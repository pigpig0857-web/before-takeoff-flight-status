"""Offline CI-only extraction and provenance audit of the resumable network batch."""
import json,hashlib,re,importlib.util,csv
from pathlib import Path
from datetime import datetime,timedelta,timezone
from ci_collection_timezones import ZoneInfo,RULES_SHA256
from collections import Counter,defaultdict
ROOT=Path('data/source-samples/crawler/ci-tpe-20261021/network')
load=lambda p:json.loads(Path(p).read_text(encoding='utf-8-sig'))
spec=importlib.util.spec_from_file_location('parser',Path(__file__).with_name('parse-kix-schedule-evidence.py'))
parser=importlib.util.module_from_spec(spec);spec.loader.exec_module(parser)
zone_file=Path('data/source-samples/crawler/tigerair-research-20261013/openflights-airports.dat')
assert hashlib.sha256(zone_file.read_bytes()).hexdigest()==load(str(zone_file)+'.receipt.json')['sha256']
zones={r[4]:r[11] for r in csv.reader(zone_file.read_text(encoding='utf8').splitlines()) if r[4]!='\\N' and r[11]!='\\N'}
zones.update(TPE='Asia/Taipei',KIX='Asia/Tokyo',MEL='Australia/Melbourne')
job=load(ROOT/'progress.json');rows={};conflicts=[];pending=[];coverage=[];hashes={}
# Reuse prior extraction only when source bytes and extraction rules are unchanged.
# Raw source hashes and query dates are still checked for every group, and the
# independent Node audit still verifies every saved source and candidate afterward.
revision=hashlib.sha256(Path(__file__).read_bytes()+Path(parser.__file__).read_bytes()+zone_file.read_bytes()+Path(__file__).with_name('ci_collection_timezones.py').read_bytes()+RULES_SHA256.encode()).hexdigest()
previous_rows=defaultdict(list);previous_coverage={};previous_hashes={};cache_reused=0
try:
 previous_audit=load(ROOT/'audit.json')
 cache_meta=load(ROOT/'parse-cache.json') if (ROOT/'parse-cache.json').exists() else None
 if not previous_audit['parsePending'] and not previous_audit['conflicts'] and (cache_meta is None or cache_meta['revision']==revision):
  for r in load(ROOT/'candidate-flights.json')['records']:previous_rows[r['evidence']['file']].append(r)
  previous_coverage={(r['origin'],r['destination'],r['date']):r['records'] for r in load(ROOT/'coverage.json')}
  previous_hashes=load(ROOT/'evidence-hashes.json')
except FileNotFoundError:pass
for group in job['completed'].values():
 file=Path(group['file']);raw=file.read_bytes();digest=hashlib.sha256(raw).hexdigest()
 assert digest==group['sha256'],str(file)
 hashes[str(file)]=digest
 html=next(c['data'] for c in json.loads(raw) if c.get('selector')=='#flight-results-wrapper')
 assert set(re.findall(r'outboundDate=(\d{4}-\d{2}-\d{2})',html))=={group['date']}
 cached=previous_rows.get(str(file),[])
 coverage_key=(group['from'],group['to'],group['date'])
 if previous_hashes.get(str(file))==digest and previous_coverage.get(coverage_key)==len(cached) and all(
  r['origin']==group['from'] and r['destination']==group['to'] and r['date']==group['date'] and
  r['fetchedAt']==group['fetchedAt'] and r['evidence']['sha256']==digest and
  r['departureTimeZone']==zones[group['from']] and r['arrivalTimeZone']==zones[group['to']] for r in cached):
  for r in cached:
   key=(r['date'],r['number'],r['origin'],r['destination'])
   if key in rows and any(rows[key][f]!=r[f] for f in ('departure','arrival')):conflicts.append(dict(old=rows[key],new=r))
   else:rows[key]=r
  coverage.append(dict(origin=group['from'],destination=group['to'],date=group['date'],records=len(cached)))
  cache_reused+=1
  continue
 tree=parser.Parser();tree.feed(html);count=0
 for index,card in enumerate(tree.root.find_all('flight-card-schedule')):
  if card.attrs.get('data-flight-airline')!='CI' or card.attrs.get('data-flight-type')!='direct':continue
  try:
   origin,target,day=group['from'],group['to'],group['date']
   route=card.find_all('flight-card-port-name')[0].text().strip()
   assert route.index('('+origin+')')<route.index('('+target+')')
   number=re.search(r'CI\d+',card.find_all('flight-card-port-code')[0].text())[0]
   dep_clock=card.find_all('flight-card-time-dep')[0].text().strip()
   arr_clock=card.find_all('flight-card-time-arr')[0].text().strip()
   assert re.fullmatch(r'\d\d:\d\d',dep_clock) and re.fullmatch(r'\d\d:\d\d',arr_clock)
   duration=re.fullmatch(r'(\d+)h\s*(\d+)m',card.find_all('flight-card-time-pass')[0].text().strip());assert duration
   minutes=int(duration[1])*60+int(duration[2]);assert 30<=minutes<=1500
   dep_zone,arr_zone=zones[origin],zones[target]
   dep=datetime.fromisoformat(day+'T'+dep_clock).replace(tzinfo=ZoneInfo(dep_zone))
   arr=(dep.astimezone(timezone.utc)+timedelta(minutes=minutes)).astimezone(ZoneInfo(arr_zone))
   assert arr.strftime('%H:%M')==arr_clock
   r=dict(date=day,number=number,airlineCode='CI',airline='中華航空',origin=origin,destination=target,
    direction='outbound' if origin=='TPE' else 'return',departure=dep.isoformat(),arrival=arr.isoformat(),
    departureTimeZone=dep_zone,arrivalTimeZone=arr_zone,minutes=minutes,
    sourceLabel='關西機場公開預定班表（OAG）',url=group.get('url','https://www.kansai-airport.or.jp/tw/flight/schedule?ajax_form=1'),
    fetchedAt=group['fetchedAt'],evidence=dict(file=str(file),sha256=digest,cardIndex=index),
    operatingAirline=None,codeshare=None,terminal=None,arrivalTerminal=None,integratedIntoWebsite=False)
   key=(day,number,origin,target)
   if key in rows and any(rows[key][f]!=r[f] for f in ('departure','arrival')):conflicts.append(dict(old=rows[key],new=r))
   else:rows[key]=r
   count+=1
  except Exception as e:pending.append(dict(file=str(file),cardIndex=index,reason=str(e)))
 coverage.append(dict(origin=group['from'],destination=group['to'],date=group['date'],records=count))
records=list(rows.values());routes=defaultdict(lambda:dict(outbound=0,returns=0,outboundDates=set(),returnDates=set()))
for r in records:
 airport=r['destination'] if r['origin']=='TPE' else r['origin'];g=routes[airport]
 g['outbound' if r['origin']=='TPE' else 'returns']+=1
for g in coverage:
 airport=g['destination'] if g['origin']=='TPE' else g['origin']
 routes[airport]['outboundDates' if g['origin']=='TPE' else 'returnDates'].add(g['date'])
route_report=[dict(airport=k,outbound=v['outbound'],returns=v['returns'],outboundDatesChecked=len(v['outboundDates']),returnDatesChecked=len(v['returnDates'])) for k,v in sorted(routes.items())]
report=dict(state=job['state'],records=len(records),outbound=sum(r['direction']=='outbound' for r in records),
 returns=sum(r['direction']=='return' for r in records),sourceHashes=len(hashes),expectedDateGroups=job['expected'],
 checkedDateGroups=len(coverage),sourcePending=len(job['pending']),parsePending=len(pending),conflicts=len(conflicts),
 allNetworkComplete=False,integratedIntoWebsite=False,routes=route_report)
report.update(cacheReusedGroups=cache_reused,freshlyParsedGroups=len(coverage)-cache_reused)
for name,obj in [('candidate-flights.json',dict(records=records)),('audit.json',report),('coverage.json',coverage),('evidence-hashes.json',hashes),('parse-pending.json',pending),('conflicts.json',conflicts)]:
 (ROOT/name).write_text(json.dumps(obj,ensure_ascii=False,indent=2),encoding='utf8')
(ROOT/'parse-cache.json').write_text(json.dumps(dict(revision=revision,checkedDateGroups=len(coverage),note='Prior verified extraction reused only for identical source hashes and unchanged parser rules; full provenance audit still required.')),encoding='utf8')
print(json.dumps(report,ensure_ascii=False))
if __name__=='__main__':
 import subprocess
 subprocess.run([r'C:\Users\88697\AppData\Local\Author Software\nvm\installs\v24.20.0\node.exe','scripts/crawler/audit-ci-network-20261021.mjs'],check=True)
