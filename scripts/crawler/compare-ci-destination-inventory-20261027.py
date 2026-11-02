"""Compare both valid official booklets with saved TPE CI route inventory.

Map labels discover destinations, not dated service. Only explicit timetable
validity and flight-day masks can produce new dated research candidates.
"""
import hashlib
import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import pdfplumber

BASE = Path('data/source-samples/crawler/ci-tpe-20261021')
RECHECK = BASE/'recheck-20261027'
OUT = BASE/'destination-inventory-20261027'
load = lambda p: json.loads(p.read_text(encoding='utf-8-sig'))
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
LABELS = dict(zip(
    ['TOKYO NARITA','OSAKA KANSAI','SAPPORO NEW CHITOSE','NAGOYA','TOYAMA','HIROSHIMA',
     'TAKAMATSU','FUKUOKA','KUMAMOTO','KAGOSHIMA','OKINAWA','SEOUL INCHEON','PUSAN',
     'BANGKOK','CHIANG MAI','KUALA LUMPUR','PENANG','SINGAPORE','JAKARTA','DENPASAR BALI',
     'HO CHI MINH CITY','DA NANG','HANOI','YANGON','PHNOM PENH KTI','KOROR PALAU','MANILA',
     'CEBU','BRUNEI','HONG KONG','BEIJING CAPITAL','SHANGHAI PUDONG','GUANGZHOU','SHENZHEN',
     'QINGDAO','WUHAN','CHENGDU SHUANGLIU','CHENGDU','FUZHOU','NANJING','NINGBO','XIAMEN',
     'ZHENGZHOU','LOS ANGELES','LA,ONTARIO','PHOENIX','SAN FRANCISCO','SEATTLE','NEW YORK JFK',
     'VANCOUVER','SYDNEY','BRISBANE','MELBOURNE','FRANKFURT','AMSTERDAM','LONDON HEATHROW',
     'VIENNA','PRAGUE','ROME'],
    ['NRT','KIX','CTS','NGO','TOY','HIJ','TAK','FUK','KMJ','KOJ','OKA','ICN','PUS','BKK',
     'CNX','KUL','PEN','SIN','CGK','DPS','SGN','DAD','HAN','RGN','KTI','ROR','MNL','CEB',
     'BWN','HKG','PEK','PVG','CAN','SZX','TAO','WUH','CTU','CTU','FOC','NKG','NGB','XMN',
     'CGO','LAX','ONT','PHX','SFO','SEA','JFK','YVR','SYD','BNE','MEL','FRA','AMS','LHR',
     'VIE','PRG','FCO']))


def inventory(pdf, expected_hash, period):
    assert digest(pdf) == expected_hash
    sections, brunei = [], []
    with pdfplumber.open(pdf) as doc:
        cover = re.findall(r'\d{4}\.\d{2}\.\d{2}', doc.pages[0].extract_text())
        assert [v.replace('.', '-') for v in cover] == list(period)
        for pno in range(3,10):  # Published TPE route section; excludes codeshare onward section.
            page = doc.pages[pno]
            for direction, box in [('outbound',(0,0,page.width/2,page.height)),
                                   ('return',(page.width/2,0,page.width,page.height))]:
                text = page.crop(box).extract_text() or ''
                current = None
                for line_no, line in enumerate(text.splitlines(),1):
                    line = line.strip().replace(' --> ', ' ')
                    # Any airport heading ends preceding section, including TSA/other origins.
                    if re.search(r'\d+h',line) and ('TAIPEI ' in line or re.match(r'^[A-Z][A-Z ,]+ \d+h',line)):
                        current = None
                        match = re.match(r'^TAIPEI TAOYUAN (.+?)\s+\d+h',line) if direction=='outbound' else re.match(r'^(.+?) TAIPEI TAOYUAN\s+\d+h',line)
                        if match:
                            assert match[1] in LABELS, (pdf,pno,line)
                            current = dict(airport=LABELS[match[1]], label=match[1], direction=direction,
                                           marketingCarriers=[], flightNumbers=[], page=pno+1,
                                           file=str(pdf),sha256=expected_hash,sourceHeading=line,rows=[])
                            sections.append(current)
                    row = re.match(r'^(CI|AE)\s+(\d{3,4})\s*(?:\(([A-Z0-9]{2})\s*(\d+)\))?',line)
                    if current and row and re.search(r'\d{2}:\d{2}-\d{2}:\d{2}',line):
                        current['marketingCarriers'].append(row[1])
                        current['flightNumbers'].append(row[1]+row[2])
                        current['rows'].append(line)
                        if current['airport']=='BWN':
                            m = re.fullmatch(r'CI\s+(950[34])\s+\(BI\s+(45[12])\)\s+([1-7 .●·]+?)\s+(\d{2}:\d{2})-(\d{2}:\d{2})\s+32N\s+-',line)
                            assert m, line
                            days = {int(n) for n in m[3] if n.isdigit()}
                            first=max(date(2026,10,21),date.fromisoformat(period[0]))
                            last=min(date(2026,12,31),date.fromisoformat(period[1]))
                            for n in range((last-first).days+1):
                                day=first+timedelta(days=n)
                                if day.isoweekday() not in days: continue
                                dep=f'{day}T{m[4]}:00+08:00'
                                arr=f'{day}T{m[5]}:00+08:00'
                                assert (datetime.fromisoformat(arr)-datetime.fromisoformat(dep)).total_seconds()==215*60
                                brunei.append(dict(date=str(day),number='CI'+m[1],marketingCarrier='CI',
                                    operatingCarrier='BI',operatingNumber='BI'+m[2],operatingAirline='Royal Brunei Airlines',
                                    origin='TPE' if direction=='outbound' else 'BWN',
                                    destination='BWN' if direction=='outbound' else 'TPE',
                                    departure=dep,arrival=arr,departureTimeZone='Asia/Taipei' if direction=='outbound' else 'Asia/Brunei',
                                    arrivalTimeZone='Asia/Brunei' if direction=='outbound' else 'Asia/Taipei',
                                    minutes=215,codeshare=True,requiresReview=False,sourceValidFrom=period[0],sourceValidUntil=period[1],
                                    dateBasis='Published cover validity intersected with printed row flight-day mask; no estimated service.',
                                    evidence=dict(file=str(pdf),sha256=expected_hash,page=pno+1,column=direction,lineNumber=line_no,sourceRow=line),
                                    url='https://cms-externalcontent-prod.s3.ap-northeast-1.amazonaws.com/ci/Prepare%20for%20the%20fly/CI-timetable.pdf',
                                    integratedIntoWebsite=False))
    return sections,brunei


if __name__=='__main__':
    OUT.mkdir(exist_ok=True)
    baseline_file=BASE/'consolidated-candidates.json'
    old=load(baseline_file)['groups']
    previous=load(RECHECK/'confirmed-ci-extension.json')['records']
    identity=lambda r:'|'.join(r[k] for k in ('date','number','origin','destination'))
    keys={g['identity'] for g in old}|{identity(r) for r in previous}
    covered={a for k in keys for a in k.split('|')[-2:] if a!='TPE'}
    winter=RECHECK/'CI-timetable.pdf'
    summer=BASE/'winter/downloads/ci-timetable.body'
    sections1,rows1=inventory(summer,load(BASE/'winter/downloads/ci-timetable.receipt.json')['sha256'],('2026-07-01','2026-10-24'))
    sections2,rows2=inventory(winter,load(RECHECK/'timetable-version.receipt.json')['sha256'],('2026-10-25','2027-03-27'))
    sections=sections1+sections2
    routes=[]
    for airport in sorted({s['airport'] for s in sections}):
        selected=[s for s in sections if s['airport']==airport]
        carriers=sorted({c for s in selected for c in s['marketingCarriers']})
        assert {s['direction'] for s in selected}=={'outbound','return'}
        routes.append(dict(airport=airport,carriers=carriers,directions=['outbound','return'],
                           previouslySavedCI=airport in covered,
                           status='already_has_ci_candidates' if airport in covered else 'new_ci_route_gap' if 'CI' in carriers else 'ae_marketed_separate_scope'))
    fresh=[r for r in rows1+rows2 if identity(r) not in keys]
    assert len(fresh)==len({identity(r) for r in fresh})
    report=dict(checkedAt=datetime.now(timezone.utc).isoformat(),officialTPEBookletDestinations=len(routes),
                officialTPEBookletCIDestinations=sum('CI' in r['carriers'] for r in routes),
                missingCIRoutesBefore=[r['airport'] for r in routes if r['status']=='new_ci_route_gap'],
                aeOnlyDestinations=[r['airport'] for r in routes if r['carriers']==['AE']],
                newCIIdentities=len(fresh),newOutbound=sum(r['origin']=='TPE' for r in fresh),newReturn=sum(r['destination']=='TPE' for r in fresh),
                previousCombinedCIIdentities=len(keys),combinedCIIdentities=len(keys|{identity(r) for r in fresh}),
                bookletCIRouteGapsAfter=[],unresolvedWuhanClockConflicts=18,integratedIntoWebsite=False,
                baselineSha256=digest(baseline_file),
                limitation='Route-level completeness against published TPE booklet sections only; not a per-flight completeness guarantee or all worldwide codeshare destinations.')
    for name,value in [('official-tpe-sections.json',sections),('route-comparison.json',routes),('brunei-candidates.json',{'records':fresh}),('audit.json',report)]:
        (OUT/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))
