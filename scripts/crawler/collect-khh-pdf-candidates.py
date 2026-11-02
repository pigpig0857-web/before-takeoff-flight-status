"""Offline candidate extraction; does not change website data or verification."""
import datetime as dt
import hashlib
import importlib.util
import json
import re
from collections import Counter
from pathlib import Path
from zoneinfo import ZoneInfo
import pdfplumber
from pypdf import PdfReader

ROOT = Path('data/source-samples/crawler/khh-new-airlines-20261015')
START, END = dt.date(2026, 10, 15), dt.date(2026, 12, 31)
read = lambda p: json.loads(Path(p).read_text(encoding='utf-8-sig'))
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
def save(name, value):
    (ROOT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
pins = read(ROOT / 'protected-hashes.json')
for file, digest in pins.items(): assert sha(file) == digest, file
spec = importlib.util.spec_from_file_location('peach_cells', 'scripts/crawler/extract-peach.py')
cells = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cells)
sources = read(ROOT / 'sources.json')
rules, records, audits = [], [], []
for source in sources:
    assert source['status'] == 200 and sha(source['file']) == source['sha256']
    tag, summer = source['tag'], source['tag'].endswith('summer')
    first, last = (dt.date(2026, 3, 29), dt.date(2026, 10, 24)) if summer else (dt.date(2026, 10, 25), dt.date(2027, 3, 27))
    these = []
    if tag.startswith('peach'):
        matches = []
        with pdfplumber.open(source['file']) as doc:
            for page_no, page in enumerate(doc.pages, 1):
                headers = sorted([r for r in page.rects if r['x0'] < 40 and 550 < r['x1'] < 560 and 10 < r['height'] < 20], key=lambda r:r['top'])
                for i, header in enumerate(headers):
                    title = cells.cell_text(page,34,556,header['top'],header['bottom'])
                    if 'Kaohsiung' not in title: continue
                    assert title == 'Osaka (Kansai) - Kaohsiung'
                    matches.append((page_no,title))
                    end_header = headers[i+1]['top'] if i+1 < len(headers) else page.height
                    lines = [e for e in page.lines if abs(e['top']-e['bottom']) < .1 and 297 < e['x0'] < 412 and 550 < e['x1'] < 556 and header['bottom'] <= e['top'] < end_header]
                    labels = [w for w in page.extract_words() if 300 < w['x0'] < 333 and header['bottom'] < w['top'] < end_header and w['text']=='Flight']
                    assert len(labels)==1
                    direction=cells.cell_text(page,298,555.3,header['bottom'],labels[0]['top'])
                    assert direction == 'Kaohsiung → Osaka (Kansai)'
                    top=min(e['top'] for e in lines if e['top']>labels[0]['bottom']); bottom=max(e['top']for e in lines)
                    cuts=cells.merged_cuts([top,bottom]+[e['top']for e in lines if e['x0']<=411 and top-.5<=e['top']<=bottom+.5])
                    for row_index,(y0,y1)in enumerate(zip(cuts,cuts[1:])):
                        middle=(y0+y1)/2
                        number=cells.column_text(page,lines,298.2,333,middle,top,bottom)
                        departure=cells.column_text(page,lines,333,370.5,middle,top,bottom)
                        arrival=cells.column_text(page,lines,370.5,410,middle,top,bottom).replace('▶','').strip()
                        dates=cells.cell_text(page,410,555.3,y0,y1)
                        if not departure and not arrival and not dates: continue
                        assert re.fullmatch(r'MM\d{3,4}',number)
                        assert re.fullmatch(r'\d{1,2}:\d{2}',departure) and re.fullmatch(r'\d{1,2}:\d{2}',arrival)
                        if dates:
                            assert summer and (number,dates) in [('MM6034','10/9'),('MM6036','10/11')]
                            month,day=map(int,dates.split('/'));a=b=dt.date(2026,month,day)
                        else:
                            assert number=='MM032';a,b=first,last
                        these.append({'number':number,'airport':'KIX','departure':departure.zfill(5),'arrival':arrival.zfill(5),'days':'Daily','first':str(a),'last':str(b),'rawDates':dates,'blankDatesPolicy':'daily_within_source_validity' if not dates else None,'page':page_no,'rowIndex':row_index,'bbox':[298.2,y0,555.3,y1]})
            assert matches == [(1,'Osaka (Kansai) - Kaohsiung')]
        assert len(these)==(3 if summer else 1)
        assert [(r['number'],r['departure'],r['arrival'])for r in these if r['number']=='MM032']==[('MM032','14:10' if summer else '14:20','18:15' if summer else '18:05')]
    else:
        pattern=re.compile(r'(GK(?:18|98))\s+(\d{2}:\d{2})\s+(\d{2}:\d{2})\s+(Daily|[.1-7]{7})\s+(\d{1,2}/\d{1,2}(?:-\d{1,2}/\d{1,2})?)')
        doc=PdfReader(source['file']);assert len(doc.pages)==1
        layout=doc.pages[0].extract_text(extraction_mode='layout')
        compact=re.sub(r'\s+','',layout)
        assert ('2026/3/29-2026/10/24' if summer else '2026/10/25-2027/3/27')in compact
        # Independently extract every selected row with pdfplumber, including columns.
        with pdfplumber.open(source['file'])as pdf:
            alternative=pdf.pages[0].extract_text()
        got=[]
        for line_no,line in enumerate(layout.splitlines(),1):
            match=pattern.search(line)
            if not match:continue
            number,departure,arrival,days,period=match.groups();got.append(match.groups())
            def date_value(text):
                m,d=map(int,text.split('/'));return dt.date(2027 if not summer and m<10 else 2026,m,d)
            limits=period.split('-');a,b=date_value(limits[0]),date_value(limits[-1]);assert first<=a<=b<=last
            assert ('高雄（KHH）'in layout and 'Kaohsiung (KHH)'in layout)
            assert '高雄（KHH）' in layout and '東京／成田' in layout
            these.append({'number':number,'airport':'NRT'if number=='GK18'else'OKA','departure':departure,'arrival':arrival,'days':days,'first':str(a),'last':str(b),'rawPeriod':period,'page':1,'lineIndex':line_no,'sourceLine':line.strip()})
        assert got==[m.groups()for m in pattern.finditer(alternative.replace('▲',' '))]
        assert len(these)==(2 if summer else 4)
    for rule in these:
        rule.update(sourceUrl=source['url'],sourceFile=source['file'],sha256=source['sha256'],fetchedAt=source['fetchedAt'],season='summer'if summer else'winter')
        rules.append(rule)
        day=max(START,dt.date.fromisoformat(rule['first']))
        while day<=min(END,dt.date.fromisoformat(rule['last'])):
            if rule['days']=='Daily'or str(day.isoweekday())in rule['days']:
                depart=dt.datetime.combine(day,dt.time.fromisoformat(rule['departure']),ZoneInfo('Asia/Taipei'))
                arrive=dt.datetime.combine(day,dt.time.fromisoformat(rule['arrival']),ZoneInfo('Asia/Tokyo'))
                minutes=int((arrive-depart).total_seconds()/60);assert 60<=minutes<=240
                records.append({'origin':'KHH','airlineCode':'MM'if tag.startswith('peach')else'GK','airline':'樂桃航空'if tag.startswith('peach')else'捷星日本航空','number':rule['number'],'date':str(day),'airport':rule['airport'],'destination':{'KIX':'大阪','NRT':'東京','OKA':'沖繩'}[rule['airport']],'countryCode':'JP','departure':depart.isoformat(timespec='seconds'),'arrival':arrive.isoformat(timespec='seconds'),'arrivalTimeZone':'Asia/Tokyo','minutes':minutes,'aircraft':None,'terminal':None,'arrivalTerminal':None,'gate':None,'counter':None,'url':source['url'],'fetchedAt':source['fetchedAt'],'sourceRuleIndex':len(rules)-1,'evidence':{'file':source['file'],'sha256':source['sha256'],'page':rule['page']},'publishedTerminalReference':None if tag.startswith('peach')else{'basis':'official_pdf_route_headers','departure':'國際線航廈','arrival':'第三航廈'if rule['airport']=='NRT'else'國際線航廈'},'sourceNotice':'依官方季節班表適用日期與星期整理，非即時動態或訂位庫存。'})
            day+=dt.timedelta(days=1)
    save('checkpoint-'+tag+'.json',{'state':'extracted','source':source,'rules':these,'cumulativeRecords':len(records)})
records.sort(key=lambda r:(r['date'],r['departure'],r['number']))
assert len(records)==167
assert Counter(r['number']for r in records)=={'MM032':78,'GK18':78,'GK98':11}
assert len({(r['date'],r['number'],r['airport'])for r in records})==167
assert all(not(r['number']=='GK98'and r['date']<'2026-12-06')for r in records)
assert next(r for r in records if r['number']=='GK18'and r['date']=='2026-12-06')['departure'][11:16]=='15:10'
assert next(r for r in records if r['number']=='GK18'and r['date']=='2026-12-07')['departure'][11:16]=='14:00'
required=['origin','airlineCode','number','date','airport','countryCode','departure','arrival','arrivalTimeZone','minutes','url','fetchedAt','evidence']
missing=sum(any(not row.get(key) for key in required)for row in records)
assert missing==0
assert all(count==1 for count in Counter((row['date'],row['number'])for row in records if row['number']in ['MM032','GK18']).values())
assert all(dt.date.fromisoformat(row['date']).isoweekday()in [3,5,7]for row in records if row['number']=='GK98')
for code in ['MM','GK']:
    selected=[r for r in records if r['airlineCode']==code]
    for month in ['2026-10','2026-11','2026-12']:
        save(f'{code}-{month}.json',[r for r in selected if r['date'].startswith(month)])
    save(f'{code}-candidates.json',{'version':1,'scope':{'origin':'KHH','from':str(START),'through':str(END)},'integratedIntoWebsite':False,'records':selected,'rules':[r for r in rules if r['number'].startswith(code)]})
for file,digest in pins.items():assert sha(file)==digest,file
result={'state':'candidate_collection_completed_not_imported','scope':{'origin':'KHH','from':str(START),'through':str(END)},'records':167,'byAirline':{'MM':78,'GK':89},'byNumber':dict(Counter(r['number']for r in records)),'byMonth':dict(Counter(r['date'][:7]for r in records)),'duplicates':0,'missingCoreFields':missing,'fullDateCoverageBothAirlines':all(len({r['date']for r in records if r['airlineCode']==code})==78 for code in ['MM','GK']),'visuallyReviewed':True,'independentJetstarExtractionAgrees':True,'peachGeometryReviewed':True,'extractionNotice':'pypdf warns about rotated text outside the selected data rows; every selected Jetstar row agrees with pdfplumber and both full source pages were visually inspected.','outOfScopePeachSpecialDatesExcluded':['2026-10-09','2026-10-11'],'protectedFilesUnchanged':len(pins),'newAirlineHTTPRequests':0,'integratedIntoWebsite':False,'longTermAvailabilityProven':False,'sources':sources}
save('audit.json',result)
print(json.dumps({k:v for k,v in result.items()if k!='sources'},ensure_ascii=False))
