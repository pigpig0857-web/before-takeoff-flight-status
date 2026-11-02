"""Merge verified return batches without overwriting production data."""
import json,hashlib
from pathlib import Path
from collections import Counter
root=Path('data/source-samples/crawler/return-world-20261019')
load=lambda p:json.loads(p.read_text(encoding='utf8'))
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
identity=lambda r:(r['date'],r['airlineCode'],r['number'],r['departureAirport'],r['arrivalAirport'])
records={identity(r):r for r in load(Path('src/server/data/return-flights.json'))['records']}
previous=len(records);source_files=[];compared=0;conflicts=[]
airport_countries={r['code']:r['countryCode'] for r in load(Path('src/features/flights/data/airport-directory.json'))}
for name in ('JX','7C','VN','PR-latest','GK-latest','KIX'):
    base=root/'verified'/name
    assert load(base/'independent-audit.json')['status']=='passed'
    file=base/'candidate-flights.json';source_files.append(dict(file=str(file),sha256=sha(file)))
    for row in load(file)['records']:
        k=identity(row)
        if k in records:
            compared+=1
            if any(records[k][f]!=row[f] for f in ('departure','arrival','minutes')):
                conflicts.append(dict(identity=k,saved=records[k],observed=row))
            continue
        records[k]=row
out=root/'staging';out.mkdir(exist_ok=True)
rows=sorted(records.values(),key=lambda r:(r['date'],r['departure'],r['airlineCode'],r['number']))
archive=load(root/'verified/NU/candidate-flights.json')['records']
from datetime import date,timedelta
assert all((str(date(2026,10,25)+timedelta(days=i)),'GK','GK57','KIX','TPE') in records for i in range(68))
routes={(r['airlineCode'],r['departureAirport'],r['arrivalAirport']) for r in rows}
inventory=load(root/'outbound-route-inventory.json')
missing=[r for r in inventory if (r['airlineCode'],r['origin'],r['destination']) not in routes]
for month in ('2026-10','2026-11','2026-12'):
    batch=[r for r in rows if r['date'].startswith(month)];file=out/f'flights-{month}.json'
    file.write_text(json.dumps(dict(records=batch,integratedIntoWebsite=False),ensure_ascii=False,indent=2),encoding='utf8')
    (out/f'checkpoint-{month}.json').write_text(json.dumps(dict(records=len(batch),sha256=sha(file)),indent=2),encoding='utf8')
before=load(root/'website-before.json')
assert all(sha(Path('src/server/data')/name)==value for name,value in before.items())
summary=dict(state='saved_with_source_gaps',fromDate='2026-10-19',through='2026-12-31',records=len(rows),newUniqueRecords=len(rows)-previous,
             byAirline=dict(Counter(r['airlineCode'] for r in rows)),returnAirports=dict(Counter(r['arrivalAirport'] for r in rows)),
             countries=dict(Counter(airport_countries[r['departureAirport']] for r in rows)),
             airlineRoutes=len(routes),originalOutboundAirlineRoutes=len(inventory),
             crossSourceMatches=compared-len(conflicts),conflicts=len(conflicts),duplicates=0,
             historicalJtaRecordsPendingFreshness=len(archive),uncollectedAirlineRoutes=missing,
             unresolvedSourceRules=[dict(airline='IT',date='2026-10-22',number='IT707',reason='published_duration_mismatch')],
             jetstarMalformedPdfResolvedByAirport=True,websiteDataUnchanged=True,integratedIntoWebsite=False,sourceFiles=source_files)
for name,value in [('progress.json',summary),('conflicts.json',conflicts),('jta-historical-pending.json',dict(records=archive,reason='latest_official_source_403',integratedIntoWebsite=False))]:
    (out/name).write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps({k:v for k,v in summary.items() if k not in ('uncollectedAirlineRoutes','sourceFiles')},ensure_ascii=False,indent=2))
