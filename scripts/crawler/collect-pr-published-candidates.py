"""Offline extraction of the two official PDFs saved by the research probe."""
import calendar
import datetime as dt
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from zoneinfo import ZoneInfo

import pdfplumber
import pypdf

ROOT = Path('data/source-samples/crawler/new-airlines-20261015')
FROM, THROUGH = dt.date(2026, 10, 15), dt.date(2026, 12, 31)
OUT = ROOT / 'verified-philippine'
OUT.mkdir(exist_ok=True)
pins = json.loads(Path('data/automatic-verification/validation/2026-10-15-1f93fd05-6b3f-49bb-a4a6-164bacde7d11/progress.json').read_text(encoding='utf8'))['protectedHashes']
sha = lambda data: hashlib.sha256(data).hexdigest()
for file, expected in pins.items():
    assert sha(Path(file).read_bytes()) == expected, file
mapping = (ROOT / 'pr-public-page-dom.txt').read_text(encoding='utf8')
assert '台北 (台灣)-TPE' in mapping
assert 'all departure and arrival times shown in local time' in mapping
airport_mapping = (ROOT / 'pr-public-airport-proof.txt').read_text(encoding='utf8')
assert '台北 (台灣)-TPE' in airport_mapping
assert '尼諾伊艾奎諾國際機場 MNL' in airport_mapping

rules, flights, sources = [], [], []
weekday = {'Mo': 0, 'Tu': 1, 'We': 2, 'Th': 3, 'Fr': 4, 'Sa': 5, 'Su': 6}
line_pattern = re.compile(r'PR\s+(\d+)\s+(Daily|(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))*)(?:\s+\(([^)]+)\))?\s+(\d\d:\d\d)\s+(\d\d:\d\d)(?:\s+\+(\d))?$')
specs = [
    ('pr-international-summer', 3, dt.date(2026, 3, 29), dt.date(2026, 10, 24), 'March 29 - October 24, 2026'),
    ('pr-international-winter', 4, dt.date(2026, 10, 25), dt.date(2027, 3, 27), 'October 25, 2026-March 27, 2027'),
]
for ident, page_number, start, end, heading in specs:
    body = (ROOT / (ident + '.body')).read_bytes()
    receipt = json.loads((ROOT / (ident + '.receipt.json')).read_text(encoding='utf8'))
    assert receipt['status'] == 200 and sha(body) == receipt['sha256']
    pdf = pypdf.PdfReader(ROOT / (ident + '.body'))
    text = pdf.pages[page_number - 1].extract_text()
    assert heading in re.sub(r'\s+', ' ', text)
    assert sum(p.extract_text().upper().count('TAIPEI TO MANILA') for p in pdf.pages) == 1
    # Independent extraction: only the right-hand Taipei -> Manila column.
    with pdfplumber.open(ROOT / (ident + '.body')) as document:
        page = document.pages[page_number - 1]
        right = page.crop((page.width / 2, 0, page.width, page.height))
        right_lines = right.extract_text().splitlines()
    index = right_lines.index('TAIPEI to MANILA')
    right_rows = []
    for line in right_lines[index + 1:]:
        if ' to ' in line:
            break
        match = line_pattern.fullmatch(line.strip())
        assert match, line
        right_rows.append(match.groups())
    # Reconcile every row against the separately parsed full-page text.
    section = text.split('TAIPEI to MANILA', 1)[1].split('MANILA to TOKYO', 1)[0]
    full_rows = []
    for line in section.splitlines():
        if not line.strip():
            continue
        matches = list(re.finditer(r'PR\s+\d+', line))
        assert len(matches) == 2, line
        match = line_pattern.fullmatch(line[matches[1].start():].strip())
        assert match, line
        full_rows.append(match.groups())
    assert full_rows == right_rows
    assert len(right_rows) == 3
    sources.append({'file':str(ROOT / (ident + '.body')), 'url':receipt['url'], 'sha256':receipt['sha256'], 'fetchedAt':receipt['fetchedAt'], 'page':page_number, 'validFrom':str(start), 'validThrough':str(end)})
    for row_index, (number, days, exception, departure, arrival, offset) in enumerate(right_rows):
        first, last = start, end
        if exception:
            # This is the only dated restriction in the Taipei rows, Feb 2027.
            assert exception == 'Feb 04-11', exception
            first, last = dt.date(2027, 2, 4), dt.date(2027, 2, 11)
        operating = set(range(7)) if days == 'Daily' else {weekday[x] for x in days.split('-')}
        rule = {'number':'PR'+number, 'weekdays':sorted(operating), 'from':str(first), 'through':str(last), 'departureLocal':departure, 'arrivalLocal':arrival, 'arrivalDayOffset':int(offset or 0), 'source':sources[-1], 'row':row_index, 'restriction':exception}
        rules.append(rule)
        date = max(first, FROM)
        while date <= min(last, THROUGH):
            if date.weekday() in operating:
                depart = dt.datetime.combine(date, dt.time.fromisoformat(departure), ZoneInfo('Asia/Taipei'))
                arrive = dt.datetime.combine(date + dt.timedelta(days=int(offset or 0)), dt.time.fromisoformat(arrival), ZoneInfo('Asia/Manila'))
                minutes = int((arrive.astimezone(dt.timezone.utc) - depart.astimezone(dt.timezone.utc)).total_seconds() / 60)
                assert 0 < minutes < 1440
                flights.append({'number':'PR'+number,'airline':'菲律賓航空','airlineCode':'PR','origin':'TPE','airport':'MNL','destination':'馬尼拉','countryCode':'PH','date':str(date),'departure':depart.isoformat(timespec='seconds'),'arrival':arrive.isoformat(timespec='seconds'),'arrivalTimeZone':'Asia/Manila','minutes':minutes,'terminal':None,'arrivalTerminal':None,'aircraft':None,'codeshare':None,'operatingAirline':None,'operatingNumber':None,'sourceKind':'official_published_pdf','url':receipt['url'],'fetchedAt':receipt['fetchedAt'],'sourcePublishedAt':'2026-10-09','evidence':{'file':sources[-1]['file'],'sha256':receipt['sha256'],'page':page_number,'rowIndex':row_index,'ruleIndex':len(rules)-1},'sourceNotice':'官方公布的季節預定班表，時間為各地當地時間，可能異動；非訂位庫存或即時動態。PDF 未另外標示逐班實際承運公司或共用班號關係，保留未知。'})
            date += dt.timedelta(days=1)
    (OUT / ('checkpoint-' + ident + '.json')).write_text(json.dumps({'rulesParsed':len(rules),'records':len(flights),'source':sources[-1]},ensure_ascii=False,indent=2)+'\n',encoding='utf8')

flights.sort(key=lambda f:(f['departure'], f['number']))
identities = {(r['date'], r['number'], r['airport']) for r in flights}
assert len(identities) == len(flights) == 156
assert Counter(r['number'] for r in flights) == {'PR891':78,'PR895':74,'PR897':4}
assert all(n == 2 for n in Counter(r['date'] for r in flights).values())
assert len({r['date'] for r in flights}) == (THROUGH - FROM).days + 1 == 78
assert all(r['number'] != 'PR897' for r in flights if r['date'] >= '2026-10-25')
assert next(r for r in flights if r['date']=='2026-12-31' and r['number']=='PR895')['arrival'].startswith('2027-01-01T00:20:00')
for month in ['2026-10','2026-11','2026-12']:
    monthly = [r for r in flights if r['date'].startswith(month)]
    raw = (json.dumps(monthly,ensure_ascii=False,indent=2)+'\n').encode()
    (OUT / ('flights-' + month + '.json')).write_bytes(raw)
    (OUT / ('checkpoint-' + month + '.json')).write_text(json.dumps({'records':len(monthly),'sha256':sha(raw)},indent=2)+'\n',encoding='utf8')
snapshot = {'version':1,'scope':{'origin':'TPE','from':str(FROM),'through':str(THROUGH),'inclusive':True},'integratedIntoWebsite':False,'sources':sources,'rules':rules,'records':flights}
(OUT / 'candidate-flights.json').write_text(json.dumps(snapshot,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
for file, expected in pins.items():
    assert sha(Path(file).read_bytes()) == expected, file
audit = {'state':'verified_published_candidate_not_imported','records':len(flights),'byMonth':dict(Counter(r['date'][:7] for r in flights)),'byFlightNumber':dict(Counter(r['number'] for r in flights)),'dateCoverage':78,'byAirport':{'MNL':156},'duplicates':0,'missingCoreFields':0,'independentPDFExtractionAgrees':True,'relevantPagesVisuallyReviewed':True,'sourceHashesVerified':True,'airportMappingEvidence':'pr-public-airport-proof.txt','protectedFilesUnchanged':len(pins),'unknownFields':['aircraft','departureTerminal','arrivalTerminal','counter','gate','operatingAirline','operatingNumber','codeshareRelationship'],'scopeLimitation':'Only the Taipei -> Manila section published in the two PDFs; no claim of all inventory or future ad-hoc flights','automaticRefreshAdapterImplemented':False,'longTermStabilityProven':False,'integratedIntoWebsite':False}
(OUT / 'audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print(json.dumps(audit,ensure_ascii=False))
