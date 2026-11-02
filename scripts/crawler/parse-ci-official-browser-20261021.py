"""Extract only visible dated direct-flight rows from saved official browser evidence."""
import json,re,hashlib,csv
from pathlib import Path
from datetime import datetime,timedelta,timezone
from ci_collection_timezones import ZoneInfo
ROOT=Path('data/source-samples/crawler/ci-tpe-20261021/official-browser')
zone_file=Path('data/source-samples/crawler/tigerair-research-20261013/openflights-airports.dat')
assert hashlib.sha256(zone_file.read_bytes()).hexdigest()==json.loads(Path(str(zone_file)+'.receipt.json').read_text(encoding='utf-8-sig'))['sha256']
zones={r[4]:r[11] for r in csv.reader(zone_file.read_text(encoding='utf8').splitlines()) if r[4]!='\\N' and r[11]!='\\N'}
zones.update(TPE='Asia/Taipei',MEL='Australia/Melbourne')
records={};evidence={};differences=[];coverage=set();route_expansions=[];column_aligned_rows=0
for file in ROOT.glob('*.ax.txt'):
 filename=re.fullmatch(r'([A-Z]{3})-([A-Z]{3})-(\d{4}-\d{2}-\d{2})\.ax\.txt',file.name)
 if not filename:continue
 raw=file.read_bytes();text=raw.decode('utf8');digest=hashlib.sha256(raw).hexdigest()
 blocks=re.split(r'\n\s*\d+ row table-outbound-row-\d+',text)[1:]
 if not blocks:continue
 assert '('+filename[1]+')' in text and '('+filename[2]+')' in text
 center=datetime.fromisoformat(filename[3]).date()
 header=re.split(r'\n\s*\d+ row table-outbound-row-\d+',text)[0]
 months={'一月':1,'二月':2,'三月':3,'四月':4,'五月':5,'六月':6,'七月':7,'八月':8,'九月':9,'十月':10,'十一月':11,'十二月':12}
 header_date_list=[f'{year}-{months[month]:02d}-{int(day):02d}' for day,month,year in re.findall(r'text 星期[一二三四五六日] (\d{2}) ([一二三四五六七八九十]+月) (\d{4})',header)]
 header_dates=set(header_date_list)
 assert {(center+timedelta(days=i)).isoformat() for i in range(-3,4)}<=header_dates,(file,header_dates)
 for i in range(-3,4):
  day=(center+timedelta(days=i)).isoformat()
  if '2026-10-21'<=day<='2026-12-31':coverage.add(filename[1]+'-'+filename[2]+'-'+day)
 evidence[str(file)]=digest
 for index,block in enumerate(blocks):
  duration=re.search(r'text 歷時:\s*(\d+)h(\d+)m 直飛航班',block)
  if not duration:continue
  times=re.findall(r'text (\d\d:\d\d)(?:\s*\+(\d+)\s*(?:日|天)\.?)?\s+[^\n]*?\(([A-Z]{3})\)',block)
  assert len(times)==2,(file,index,times)
  dep_clock,_,origin=times[0];arr_clock,offset,target=times[1]
  number=re.search(r'\(CI (\d+)\)',block)
  if not number:continue
  # Official city searches can also list a nearby airport (e.g. ONT in LAX results).
  # Retain the explicitly printed physical airport, never rename it to the query.
  matches_query=origin==filename[1] and target==filename[2]
  if not matches_query:
   route_expansions.append(dict(file=str(file),rowIndex=index,queriedOrigin=filename[1],queriedDestination=filename[2],
    actualOrigin=origin,actualDestination=target,number='CI'+number[1],decision='preserve_explicit_actual_airports_without_expanding_query_coverage'))
  assert origin=='TPE' or target=='TPE',(file,index,origin,target)
  operator=re.search(r'由 (.*?) 承運',block)
  minutes=int(duration[1])*60+int(duration[2])
  explicit_dates=re.findall(r'text (\d{4})年 (\d{2})月 (\d{2})日 [^\n]+\n\s*\d+ text (適用|未提供)(?:\n|$)',block)
  if explicit_dates:
   applicable_dates=[f'{year}-{month}-{day}' for year,month,day,status in explicit_dates if status=='適用']
   availability_method='explicit_row_date'
  else:
   # Desktop tables print dates once in column headers and one status per cell.
   # Match only an exact column count; do not infer dates from weekly frequency.
   statuses=re.findall(r'\n\s*\d+ text (適用|未提供)(?:\n|$)',block)
   assert len(statuses)==len(header_date_list),(file,index,'availability/header column mismatch',len(statuses),len(header_date_list))
   applicable_dates=[day for day,status in zip(header_date_list,statuses) if status=='適用']
   availability_method='visible_column_headers';column_aligned_rows+=1
  for date in applicable_dates:
   if not '2026-10-21'<=date<='2026-12-31':continue
   dep_zone=zones[origin]
   arr_zone=zones[target]
   dep=datetime.fromisoformat(date+'T'+dep_clock).replace(tzinfo=ZoneInfo(dep_zone))
   arr=(dep.astimezone(timezone.utc)+timedelta(minutes=minutes)).astimezone(ZoneInfo(arr_zone))
   assert arr.strftime('%H:%M')==arr_clock,(file,index,date,arr.isoformat(),arr_clock)
   assert (arr.date()-dep.date()).days==int(offset or 0),(file,index,date,arr.isoformat(),offset)
   record=dict(date=date,number='CI'+number[1],airlineCode='CI',origin=origin,destination=target,
    departure=dep.isoformat(),arrival=arr.isoformat(),departureTimeZone=dep_zone,arrivalTimeZone=arr_zone,
    minutes=minutes,codeshare=bool(operator),operatingAirline=operator[1] if operator else 'China Airlines Ltd.',
    queriedOrigin=filename[1],queriedDestination=filename[2],matchesQueriedRoute=matches_query,
    availabilityDateMethod=availability_method,
    sourceLabel='華航官方時刻表（正常瀏覽器查詢）',url='https://booking.china-airlines.com/Flightschedule/',
    fetchedAt=datetime.fromtimestamp(file.stat().st_mtime,tz=timezone.utc).isoformat(),
    evidence=dict(file=str(file),sha256=digest,rowIndex=index),integratedIntoWebsite=False)
   key=(date,record['number'],origin,target)
   if key in records:assert records[key]['departure']==record['departure'] and records[key]['arrival']==record['arrival']
   records[key]=record
oag=json.loads(Path('data/source-samples/crawler/ci-tpe-20261021/network/candidate-flights.json').read_text(encoding='utf8'))['records']
lookup={(r['date'],r['number'],r['origin'],r['destination']):r for r in oag}
for key,r in records.items():
 old=lookup.get(key)
 if old and any(old[f]!=r[f] for f in ('departure','arrival')):differences.append(dict(official=r,airport=old,decision='unresolved_preserve_both'))
report=dict(records=len(records),outbound=sum(r['origin']=='TPE' for r in records.values()),
 returns=sum(r['destination']=='TPE' for r in records.values()),sourceHashes=len(evidence),
 conflictsWithAirport=len(differences),additionalAirportRows=len(route_expansions),headerAlignedAvailabilityRows=column_aligned_rows,integratedIntoWebsite=False,allNetworkComplete=False)
for name,obj in [('candidate-flights.json',dict(records=list(records.values()))),('audit.json',report),('evidence-hashes.json',evidence),('differences.json',differences),('route-expansions.json',route_expansions),('covered-date-groups.json',sorted(coverage))]:
 (ROOT/name).write_text(json.dumps(obj,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(report,ensure_ascii=False))
