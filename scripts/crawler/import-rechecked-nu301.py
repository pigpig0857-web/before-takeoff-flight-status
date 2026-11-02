"""Import only the 31 explicitly published December departures; preserve live-review status."""
import json,hashlib,datetime as dt
from pathlib import Path
root=Path('data/source-samples/crawler/gap-recheck-20261020')
read=lambda p:json.loads(Path(p).read_text(encoding='utf-8'))
digest=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
historical=read('data/source-samples/crawler/return-world-20261019/staging/jta-historical-pending.json')['records']
source=Path('data/source-samples/crawler/new-airlines-20261014/jta-browser-schedule.json')
proof=read(source);table=proof['tables'][1];row=next(r for r in table['rows'] if r[0]=='NU301')
assert proof['periods'][1]=='2026-10-25/2027-03-27'
assert row[2].startswith('8:35') and 'December 1 to January 31' in row[2] and 'advanced by 5 minutes' in row[2]
assert row[3]=='9:15' and row[4]=='Daily'
index=read(root/'jta-official-index-evidence.json')
assert index['flight']=='NU301' and index['scheduleFrom']=='2026-10-25' and index['scheduleThrough']=='2027-03-27'
assert index['exception']=={'from':'December 1','through':'January 31','departureMinutesEarlier':5}
assert index['departureLocal']=='08:35' and index['arrivalLocal']=='09:15' and index['liveVerifiedAt'] is None
records=[]
for r in historical:
 if r['number']!='NU301' or not '2026-12-01'<=r['date']<='2026-12-31':continue
 assert r['sourceSha256']==digest(source) and r['fetchedAt']==proof['capturedAt']
 assert r['departure']==r['date']+'T08:30:00+09:00' and r['arrival']==r['date']+'T09:15:00+08:00'
 assert r['minutes']==105
 records.append({**r,'supportingEvidence':{'file':str(root/'jta-official-index-evidence.json'),'sha256':digest(root/'jta-official-index-evidence.json'),
  'method':'Official page search-index snapshot corroborates preserved original official table; not a live origin success'},
  'sourceNotice':'依先前保存的官方冬季班表與12月日期調整補入；最新資料尚待重新核對，訂位前請向航空公司確認。'})
assert len(records)==31 and len(set(r['date'] for r in records))==31
file=Path('src/server/data/return-flights.json');original=file.read_bytes();snapshot=json.loads(original)
identity=lambda r:(r['date'],r['number'],r['departureAirport'],r['arrivalAirport'])
old={identity(r) for r in snapshot['records']}
if all(identity(r) in old for r in records):raise SystemExit('Already imported; no changes')
assert snapshot['pendingCount']==32 and len(snapshot['records'])==13125
assert all(identity(r) not in old for r in records)
(root/'nu301-candidates.json').write_text(json.dumps({'records':records,'basis':'Explicit published weekday and December time exception; no guessed times'},ensure_ascii=False,indent=2),encoding='utf-8')
(root/'return-before.json').write_bytes(original)
snapshot['records'].extend(records);snapshot['version']=7;snapshot['pendingCount']=1
snapshot['gapReviewProvenance']=str(root/'progress.json')
temp=file.with_suffix('.nu301.tmp');temp.write_text(json.dumps(snapshot,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');temp.replace(file)
assert snapshot['records'][:13125]==json.loads(original)['records']
(root/'nu301-import.json').write_text(json.dumps({'state':'imported_preserved_official_schedule','added':31,'total':13156,'originalPreserved':13125,
 'fetchedAtPreserved':proof['capturedAt'],'liveVerificationRefreshed':False,'beforeSha256':hashlib.sha256(original).hexdigest(),'afterSha256':digest(file)},indent=2),encoding='utf-8')
print('Added 31 explicit December NU301 records; 13125 original returns unchanged; no successful live timestamp invented.')
