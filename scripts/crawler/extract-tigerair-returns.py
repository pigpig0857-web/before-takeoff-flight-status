"""Expand official inbound IT rules into isolated monthly research batches."""
import csv
import hashlib
import json
import re
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

root = Path('data/source-samples/crawler/return-expansion-20261019')
load = lambda p: json.loads(p.read_text(encoding='utf8'))
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
receipt = load(root / 'tigerair-receipt.json')
assert receipt['status'] == 'downloaded' and receipt['httpStatus'] == 200
assert digest(root/'tigerair-raw.json') == receipt['sha256']
zone_source = Path('data/source-samples/crawler/tigerair-research-20261013/openflights-airports.dat')
zone_receipt = load(zone_source.with_name(zone_source.name + '.receipt.json'))
assert digest(zone_source) == zone_receipt['sha256']
zones = {r[4]: r[11] for r in csv.reader(zone_source.read_text(encoding='utf8').splitlines()) if r[4] != '\\N'}
zones.update({'TPE':'Asia/Taipei', 'KHH':'Asia/Taipei'})
start, end = date(2026,10,19), date(2026,12,31)
week = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']
out = root / 'tigerair-returns'
out.mkdir(exist_ok=False)
raw = load(root/'tigerair-raw.json')
rules, pending, by_id, conflicts = [], [], {}, {}
rule_index = -1
duplicates = 0
for country in raw['data']:
    for station in country['stationSchedules']:
        for rule in station['schedules']:
            rule_index += 1
            if rule['destination'] not in ('TPE','KHH') or rule['origin'] in ('TPE','KHH'):
                continue
            info = dict(ruleIndex=rule_index, rule=rule)
            try:
                if rule['carrierCode'] != 'IT' or not re.fullmatch(r'\d+',rule['flightNumber']):
                    raise ValueError('Unrecognised carrier or number')
                if any(type(rule['daysOfWeek'][w]) is not bool for w in week):
                    raise ValueError('Invalid weekday flags')
                if type(rule['overnight']) is not int or not 0 <= rule['overnight'] <= 2:
                    raise ValueError('Invalid day offset')
                active, year = set(), None
                for segment in re.split('[,、]', rule['operationDateSummary']):
                    limits = []
                    for token in segment.strip().split('-'):
                        fields = token.strip().split('/')
                        if len(fields) == 3:
                            year = int(fields.pop(0))
                        if len(fields) != 2 or year is None:
                            raise ValueError('Unrecognised date expression')
                        limits.append(date(year,int(fields[0]),int(fields[1])))
                    if not 1 <= len(limits) <= 2 or limits[0] > limits[-1]:
                        raise ValueError('Invalid validity range')
                    a, b = max(start,limits[0]), min(end,limits[-1])
                    for offset in range((b-a).days+1):
                        day = a + timedelta(days=offset)
                        if rule['daysOfWeek'][week[day.weekday()]]:
                            active.add(day)
                expanded = []
                for day in sorted(active):
                    dep = datetime.fromisoformat(f"{day}T{rule['departureTime']}").replace(tzinfo=ZoneInfo(zones[rule['origin']]))
                    arr_day = day + timedelta(days=rule['overnight'])
                    arr = datetime.fromisoformat(f"{arr_day}T{rule['arrivalTime']}").replace(tzinfo=ZoneInfo('Asia/Taipei'))
                    minutes = int((arr.astimezone(timezone.utc)-dep.astimezone(timezone.utc)).total_seconds()/60)
                    if not 30 <= minutes <= 720 or minutes != rule['durationInMinutes']:
                        raise ValueError(f"Time/duration mismatch at {day}: calculated {minutes}, published {rule['durationInMinutes']}")
                    number = 'IT' + str(int(rule['flightNumber']))
                    expanded.append(dict(id=f"{day}|{rule['origin']}|{rule['destination']}|{number}",
                                         date=str(day), number=number, airlineCode='IT', airline='台灣虎航',
                                         departureAirport=rule['origin'], arrivalAirport=rule['destination'],
                                         departure=dep.isoformat(), arrival=arr.isoformat(),
                                         departureTimeZone=zones[rule['origin']], arrivalTimeZone='Asia/Taipei',
                                         arrivalDayOffset=rule['overnight'], minutes=minutes,
                                         url=receipt['url'], fetchedAt=receipt['fetchedAt'], sourceSha256=receipt['sha256'],
                                         sourceRuleIndexes=[rule_index], status='published_schedule',
                                         terminal=None, arrivalTerminal=None, aircraft=None, nonstop=True))
                info['expanded'] = len(expanded)
                rules.append(info)
                for record in expanded:
                    key = record['id']
                    if key in conflicts:
                        conflicts[key].append(record)
                    elif key not in by_id:
                        by_id[key] = record
                    elif all(by_id[key][k] == record[k] for k in ('departure','arrival','minutes')):
                        duplicates += 1
                        by_id[key]['sourceRuleIndexes'].extend(record['sourceRuleIndexes'])
                    else:
                        conflicts[key] = [by_id.pop(key),record]
            except (ValueError,KeyError,TypeError) as error:
                pending.append({**info,'reason':str(error)})
records = sorted(by_id.values(),key=lambda r:(r['date'],r['departure'],r['id']))
for month in ('2026-10','2026-11','2026-12'):
    selected = [r for r in records if r['date'].startswith(month)]
    target = out/f'flights-{month}.json'
    target.write_text(json.dumps(dict(records=selected,integratedIntoWebsite=False),ensure_ascii=False,indent=2),encoding='utf8')
    (out/f'checkpoint-{month}.json').write_text(json.dumps(dict(month=month,records=len(selected),sha256=digest(target))),encoding='utf8')
audit = dict(status='collected_with_pending' if pending or conflicts else 'collected',records=len(records),
             requestedFrom=str(start),requestedTo=str(end),dateBasis='origin local departure date',
             returnAirports=dict(Counter(r['arrivalAirport'] for r in records)),
             routes=dict(sorted(Counter(r['departureAirport']+'-'+r['arrivalAirport'] for r in records).items())),
             sourceRules=len(rules)+len(pending),pendingRules=len(pending),conflictingIdentities=len(conflicts),
             mergedIdenticalOverlaps=duplicates,duplicateIdentities=0,
             timezoneEvidence=dict(path=str(zone_source),sha256=digest(zone_source),url=zone_receipt['url']),
             source=receipt,integratedIntoWebsite=False,
             limitations=['Official published rules, not booking availability or live status','No inferred terminal or aircraft','Coverage limited to downloaded source'])
for name,value in [('audit.json',audit),('source-rules.json',rules),('pending.json',dict(rules=pending,conflicts=conflicts))]:
    (out/name).write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps({k:v for k,v in audit.items() if k not in ('source','timezoneEvidence','limitations')},ensure_ascii=False,indent=2))
