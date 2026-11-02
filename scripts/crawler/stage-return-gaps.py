"""Merge verified new returns with the current website snapshot without importing."""
import hashlib,json
from pathlib import Path
from collections import Counter
root=Path('data/source-samples/crawler/return-gaps-20261020')
load=lambda p:json.loads(p.read_text(encoding='utf-8-sig'))
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
baseline=load(root/'website-before.json')
assert all(sha(Path('src/server/data')/name)==value for name,value in baseline.items())
audit=load(root/'eva-returns/verified/independent-audit.json')
candidate=root/'eva-returns/verified/candidate-flights.json'
assert audit['status']=='passed' and audit['conflicts']==0
assert sha(candidate)==audit['candidateSha256']
identity=lambda r:(r['date'],r['airlineCode'],r['number'],r['departureAirport'],r['arrivalAirport'])
old=load(Path('src/server/data/return-flights.json'))['records']
records={identity(r):r for r in old}
assert len(records)==len(old)
for r in load(candidate)['records']:
    key=identity(r)
    assert key not in records,key
    records[key]=r
jtaAudit=load(root/'jta-company-verified/independent-audit.json')
jtaFile=root/'jta-company-verified/candidate-flights.json'
assert jtaAudit['status']=='passed' and sha(jtaFile)==jtaAudit['candidateSha256']
for r in load(jtaFile)['records']:
    key=identity(r)
    assert key not in records,key
    records[key]=r
rows=sorted(records.values(),key=lambda r:(r['date'],r['departure'],r['number']))
out=root/'staging';out.mkdir(exist_ok=True)
for month in ['2026-10','2026-11','2026-12']:
    selected=[r for r in rows if r['date'].startswith(month)]
    file=out/f'flights-{month}.json'
    file.write_text(json.dumps(dict(records=selected,integratedIntoWebsite=False),ensure_ascii=False,indent=2),encoding='utf8')
    (out/f'checkpoint-{month}.json').write_text(json.dumps(dict(records=len(selected),sha256=sha(file)),indent=2),encoding='utf8')
progress=load(root/'eva-returns/progress.json')
coverage=load(root/'eva-returns/verified/coverage.json')
summary=dict(state='audited_and_saved_for_import',websiteImported=False,websiteDataUnchanged=True,records=len(rows),previousWebsiteRecords=len(old),newUniqueRecords=len(rows)-len(old),
    byAirline=dict(Counter(r['airlineCode'] for r in rows)),byArrivalAirport=dict(Counter(r['arrivalAirport'] for r in rows)),
    newCollectionFrom='2026-10-20',through='2026-12-31',sourceProgress=str(root/'eva-returns/progress.json'),
    pendingRoutes=[r for r in coverage['routes'] if not r['complete']],unresolvedSourceRows=coverage['unresolved'],
    otherPending=['NU JAL page HTTP403; company announcements confirm 110 records, 32 date-specific records remain pending','2026-10-22 IT707 published duration mismatch'],
    audit=str(root/'eva-returns/verified/independent-audit.json'),duplicateIdentities=0,
    candidateSha256=audit['candidateSha256'])
(out/'progress.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps({k:v for k,v in summary.items() if k!='pendingRoutes'},ensure_ascii=False))
