"""Offline validation of saved official responses; no network or website import."""
import collections
import datetime as dt
import hashlib
import json
import pathlib
import urllib.parse
from zoneinfo import ZoneInfo

ROOT = pathlib.Path('data/source-samples/crawler/more-airlines-20261013')
START, END = '2026-10-13', '2026-12-31'

def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')

def evidence(body):
    receipt = read(body.with_suffix('.receipt.json'))
    digest = hashlib.sha256(body.read_bytes()).hexdigest()
    assert digest == receipt['sha256'] and receipt['status'] == 200
    return receipt, {'file': str(body), 'sha256': digest, 'url': receipt['url']}

def local_time(location):
    naive = dt.datetime.fromisoformat(location['dateTime'])
    offset = dt.timedelta(hours=float(location['dateTimeZoneGmtOffset']))
    return naive.replace(tzinfo=dt.timezone(offset))

def verify_time(departure, arrival, arrival_zone, seconds):
    assert departure.utcoffset() == dt.timedelta(hours=8)
    assert arrival.utcoffset() == dt.timedelta(hours=7 if arrival_zone == 'Asia/Ho_Chi_Minh' else 9)
    assert 0 < seconds < 24 * 3600
    assert (arrival - departure).total_seconds() == seconds
    # Independent IANA timezone conversion must produce the published local timestamps.
    assert departure.astimezone(ZoneInfo('Asia/Taipei')).isoformat() == departure.isoformat()
    assert arrival.astimezone(ZoneInfo(arrival_zone)).isoformat() == arrival.isoformat()

def key(row):
    return (row['number'], row['date'], row['airport'])

def record(number, airline, departure, arrival, airport, country, zone, aircraft, dep_terminal, arr_terminal, seconds, source, fetched_at):
    verify_time(departure, arrival, zone, seconds)
    return {'number': number, 'airline': airline, 'date': departure.date().isoformat(),
            'origin': 'TPE', 'airport': airport, 'countryCode': country,
            'departure': departure.isoformat(), 'arrival': arrival.isoformat(),
            'arrivalTimeZone': zone, 'durationMinutes': seconds / 60,
            'aircraft': aircraft, 'terminal': dep_terminal, 'arrivalTerminal': arr_terminal,
            'gate': None, 'counter': None, 'fetchedAt': fetched_at, 'evidence': source}

def collect_vietnam():
    own, shared, pending, cells = {}, {}, [], set()
    bodies = sorted((ROOT / 'vn-daily').glob('*.body'))
    resolutions = ROOT / 'verified-vietnam/query-resolutions.json'
    if resolutions.exists():
        for resolution in read(resolutions):
            replacement = pathlib.Path(resolution['body'])
            receipt, _ = evidence(replacement)
            assert receipt['url'] == resolution['url']
            assert isinstance(read(replacement).get('data', {}).get('departureFlight', {}).get('scheduleItems'), list)
            # Keep the original empty response on disk; use its explicitly reviewed replacement.
            bodies = [body for body in bodies if read(body.with_suffix('.receipt.json'))['url'] != receipt['url']]
            bodies.append(replacement)
    unavailable = set()
    for body in bodies:
        receipt, _ = evidence(body)
        q = urllib.parse.parse_qs(urllib.parse.urlparse(receipt['url']).query)
        items = read(body).get('data', {}).get('departureFlight', {}).get('scheduleItems')
        if not isinstance(items, list):
            unavailable.add((q['departureDate'][0], q['destinationLocationCode'][0]))
    for body in bodies:
        receipt, source = evidence(body)
        q = urllib.parse.parse_qs(urllib.parse.urlparse(receipt['url']).query)
        query_date, target = q['departureDate'][0], q['destinationLocationCode'][0]
        payload = read(body)
        items = payload.get('data', {}).get('departureFlight', {}).get('scheduleItems')
        if payload.get('success') is not True or not isinstance(items, list):
            pending.append({'queryDate': query_date, 'airport': target, 'file': str(body), 'reason': 'No scheduleItems; not zero-flight evidence'})
            continue
        cells.add((query_date, target))
        flight_data = payload['data']['departureFlight']
        dictionaries = flight_data['dictionaries']
        for index, item in enumerate(items):
            segments = item.get('connectedFlights', [])
            if not segments:
                continue
            segment = segments[0]
            info = segment['flightInfo']
            dep, arr = info['departureLocation'], info['arrivalLocation']
            airport = arr['locationCode']
            supplemental = len(segments) > 1
            # Keep an explicitly published physical first leg only for a pending route/date.
            # Do not construct a transfer itinerary or infer any flight from weekday rules.
            if supplemental and ((query_date, airport) not in unavailable or info['operatingAirlineCode'] != 'VN'):
                continue
            if dep['locationCode'] != 'TPE' or (not supplemental and airport != target) or segment['numberOfStops'] != 0:
                continue
            departure, arrival = local_time(dep), local_time(arr)
            date = departure.date().isoformat()
            if date != query_date or not START <= date <= END:
                continue  # Do not expand future sample dates or seasonal operating-day rules.
            assert departure.strftime('%A').lower() in segment['operatingDays']
            period = segment['validityPeriod']
            assert period['start'][:10] <= date <= period['end'][:10]
            assert dictionaries['location'][airport]['countryCode'] == 'VN'
            raw_aircraft = info.get('airEquipmentCode')
            aircraft = dictionaries['aircraft'].get(raw_aircraft) if raw_aircraft else None
            src = {**source, 'rowIndex': index, 'queryDate': query_date, 'queryAirport': target, 'segmentIndex': 0, 'publishedFirstLegOfConnectingResult': supplemental}
            seconds = info.get('duration', (arrival - departure).total_seconds())
            row = record(info['marketingAirlineCode'] + info['marketingFlightNumber'], '越南航空', departure, arrival, airport, 'VN', 'Asia/Ho_Chi_Minh', aircraft,
                         'T' + dep['terminal'] if dep.get('terminal') in ['1', '2'] else None, arr.get('terminal'), seconds, src, receipt['fetchedAt'])
            row.update(operatingAirlineCode=info['operatingAirlineCode'], operatingAirline=info['operatingAirlineName'], operatingNumber=None,
                       aircraftCode=raw_aircraft, codeshare=info['operatingAirlineCode'] != info['marketingAirlineCode'])
            target_map = own if info['marketingAirlineCode'] == info['operatingAirlineCode'] == 'VN' else shared
            old = target_map.get(key(row))
            if old:
                for field in ['departure', 'arrival', 'aircraft', 'terminal', 'arrivalTerminal', 'operatingAirlineCode']:
                    assert old[field] == row[field], (key(row), field)
            else:
                target_map[key(row)] = row
    return list(own.values()), list(shared.values()), pending, cells

def collect_jeju():
    routes = read(ROOT / 'jeju-weekly/jeju-tpe-destinations-schedule.body')
    evidence(ROOT / 'jeju-weekly/jeju-tpe-destinations-schedule.body')
    airports = {r['stationCode'] for r in routes['data']['data']['stations'] if r.get('mac') != 'Y' and r['connectYn'] == 'N'}
    assert airports == {'ICN', 'PUS'}
    rows, cells = {}, set()
    for body in sorted((ROOT / 'jeju-weekly').glob('jeju-*.body')):
        if 'destinations' in body.name:
            continue
        receipt, source = evidence(body)
        request = read(body.with_suffix('.started.json'))
        query_date = dt.datetime.strptime(request['body']['startDate'], '%Y%m%d').date()
        target = request['body']['arrStn']
        payload = read(body)
        assert payload['code'] == '0000' and isinstance(payload['data']['dep'], list)
        # The official response covers the query date plus/minus three days.
        week_start = query_date - dt.timedelta(days=3)
        for n in range(7):
            date = (week_start + dt.timedelta(days=n)).isoformat()
            if START <= date <= END:
                cells.add((date, target))
        for index, item in enumerate(payload['data']['dep']):
            designator, leg, identity = item['designator'], item['legDetails'], item['identifier']
            assert designator['origin'] == 'TPE' and designator['destination'] == target
            departure = dt.datetime.fromisoformat(leg['departureTimeUtc'].replace('Z', '+00:00')).astimezone(ZoneInfo('Asia/Taipei'))
            arrival = dt.datetime.fromisoformat(leg['arrivalTimeUtc'].replace('Z', '+00:00')).astimezone(ZoneInfo('Asia/Seoul'))
            assert departure.replace(tzinfo=None).isoformat() == designator['departure']
            assert arrival.replace(tzinfo=None).isoformat() == designator['arrival']
            date = departure.date().isoformat()
            assert week_start <= departure.date() <= week_start + dt.timedelta(days=6)
            if not START <= date <= END:
                continue
            assert identity['carrierCode'] == '7C' and leg['codeShareIndicator'] == 'NonCodeShare'
            assert leg['status'] in ['Normal', 'Closed']  # Not live operation status.
            seconds = (arrival - departure).total_seconds()
            row = record('7C' + identity['identifier'], '濟州航空', departure, arrival, target, 'KR', 'Asia/Seoul', None, None, None, seconds, {**source, 'rowIndex': index}, receipt['fetchedAt'])
            row.update(operatingAirlineCode='7C', operatingAirline='濟州航空', operatingNumber=None, codeshare=False, sourceScheduleFlag=leg['status'])
            old = rows.get(key(row))
            if old:
                assert all(old[f] == row[f] for f in ['departure', 'arrival', 'airport'])
            else:
                rows[key(row)] = row
    return list(rows.values()), cells

vn, shared, pending, vn_cells = collect_vietnam()
jc, jc_cells = collect_jeju()
for brand, rows, cells, errors in [('vietnam', vn, vn_cells, pending), ('jeju', jc, jc_cells, [])]:
    rows.sort(key=lambda r: (r['departure'], r['number']))
    output = ROOT / ('verified-' + brand)
    save(output / 'candidate-flights.json', {'researchOnly': True, 'integratedIntoWebsite': False, 'scope': {'origin': 'TPE', 'from': START, 'through': END}, 'records': rows})
    save(output / 'pending.json', errors)
    audit = {'state': 'verified_with_pending_queries' if errors else 'verified', 'flights': len(rows), 'duplicates': len(rows) - len({key(r) for r in rows}),
             'dateAirportCells': len(cells), 'expectedDateAirportCells': 160, 'queryDates': len({date for date, _ in cells}),
             'byMonth': dict(collections.Counter(r['date'][:7] for r in rows)), 'byAirport': dict(collections.Counter(r['airport'] for r in rows)),
             'aircraft': sum(bool(r['aircraft']) for r in rows), 'departureTerminal': sum(bool(r['terminal']) for r in rows),
             'arrivalTerminal': sum(bool(r['arrivalTerminal']) for r in rows), 'pendingQueries': len(errors),
             'supplementalPublishedFirstLegs': sum(r['evidence'].get('publishedFirstLegOfConnectingResult', False) for r in rows),
             'timeZoneDurationAndSourceHashesVerified': True, 'allAirlineDestinationsConfirmed': brand == 'jeju',
             'rawQueryCoverage': [list(cell) for cell in sorted(cells)]}
    save(output / 'audit.json', audit)
    print(json.dumps({k:v for k,v in audit.items() if k != 'rawQueryCoverage'}, ensure_ascii=False))
save(ROOT / 'verified-vietnam/codeshares-not-own-operated.json', {'researchOnly': True, 'records': shared, 'note': 'VN marketing numbers operated by another carrier. No operating flight number supplied; do not fabricate CI numbers.'})
