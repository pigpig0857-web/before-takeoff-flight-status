"""Conservative winter announcement crosscheck; date-specific exceptions stay pending."""
import json,hashlib,re
from pathlib import Path
from datetime import date,timedelta,datetime
from zoneinfo import ZoneInfo
from pypdf import PdfReader
import pdfplumber
root=Path('data/source-samples/crawler/return-gaps-20261020')
load=lambda p:json.loads(p.read_text(encoding='utf-8-sig'))
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
file=root/'jta-company-winter.body';receipt=load(root/'jta-company-winter.receipt.json')
assert receipt['status']==200 and receipt['sha256']==sha(file)
text=PdfReader(file).pages[0].extract_text()
with pdfplumber.open(file) as pdf: alternate=pdf.pages[0].extract_text()
for content in [text,alternate]:
    flat=re.sub(r'\s+','',content)
    assert '2026年10月25日' in flat and '2027年3月27日' in flat
    assert 'NU3018:359:15' in flat and 'NU30717:5518:40' in flat
    assert '毎日運航' in flat and '出発日により' in flat
historical=load(Path('data/source-samples/crawler/return-world-20261019/staging/jta-historical-pending.json'))['records']
summerFile=root/'jta-company-summer.body';summerReceipt=load(root/'jta-company-summer.receipt.json')
assert summerReceipt['status']==200 and sha(summerFile)==summerReceipt['sha256']
summerText=PdfReader(summerFile).pages[0].extract_text()
with pdfplumber.open(summerFile) as pdf: summerAlternate=pdf.pages[0].extract_text()
for content in [summerText,summerAlternate]:
    flat=re.sub(r'\s+','',content)
    assert 'NU301' in flat and '8:30' in flat and '9:05' in flat and '10月24日' in flat
records=[];pending=[]
for r in historical:
    if r['date']<'2026-10-20':continue
    summer=r['number']=='NU301' and '2026-10-20'<=r['date']<='2026-10-24'
    accepted=summer or (r['number']=='NU307' and '2026-10-25'<=r['date']<='2026-12-31') or (r['number']=='NU301' and '2026-10-25'<=r['date']<='2026-11-30')
    if not accepted:
        pending.append(dict(date=r['date'],number=r['number'],reason='Summer scope or date-specific exception not established by this winter announcement'));continue
    dep,arr=('08:30','09:05') if summer else (('08:35','09:15') if r['number']=='NU301' else ('17:55','18:40'))
    sourceReceipt=summerReceipt if summer else receipt
    sourceFile=summerFile if summer else file
    departure=datetime.fromisoformat(r['date']+'T'+dep).replace(tzinfo=ZoneInfo('Asia/Tokyo')).isoformat()
    arrival=datetime.fromisoformat(r['date']+'T'+arr).replace(tzinfo=ZoneInfo('Asia/Taipei')).isoformat()
    assert (r['departure'],r['arrival'])==(departure,arrival)
    records.append({**r,'url':sourceReceipt['url'],'fetchedAt':sourceReceipt['attemptedAt'],'sourceSha256':sourceReceipt['sha256'],
        'evidence':dict(file=str(sourceFile),page=1),
        'sourceNotice':'日本越洋官方公告預定班表，個別日期可能調整；非即時動態或可售機位。'})
assert len(records)==110 and len(pending)==32
assert len({(r['date'],r['number']) for r in records})==110
out=root/'jta-company-verified';out.mkdir(exist_ok=True)
for name,value in [('candidate-flights.json',dict(records=records,integratedIntoWebsite=False)),('pending.json',pending)]:
    (out/name).write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf8')
audit=dict(status='passed',records=110,pending=32,candidateSha256=sha(out/'candidate-flights.json'),
    method='Visual table review, independent pypdf/pdfplumber extraction, exact crosscheck against cached date-specific schedule; unresolved date-specific exceptions excluded',
    sourceSha256=sha(file),summerSourceSha256=sha(summerFile),websiteImported=False)
(out/'independent-audit.json').write_text(json.dumps(audit,indent=2),encoding='utf8')
print(json.dumps(audit))
