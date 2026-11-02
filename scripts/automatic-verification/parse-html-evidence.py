"""Offline HTML evidence extraction only; never makes a network request."""
import importlib.util
import json
import pathlib
import sys

mode, file = sys.argv[1:3]
if mode == 'kix':
    spec = importlib.util.spec_from_file_location('kix_parser', 'scripts/crawler/parse-kix-schedule-evidence.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    print(json.dumps(module.parse_saved(pathlib.Path(file), sys.argv[3]), ensure_ascii=False))
elif mode == 'khh_oag':
    import datetime as dt
    import re
    from zoneinfo import ZoneInfo
    date, airport = sys.argv[3:5]
    zones = {'NRT': 'Asia/Tokyo', 'KIX': 'Asia/Tokyo', 'ICN': 'Asia/Seoul',
             'HKG': 'Asia/Hong_Kong', 'BKK': 'Asia/Bangkok', 'MNL': 'Asia/Manila', 'KUL': 'Asia/Kuala_Lumpur'}
    assert airport in zones and '2026-10-20' <= date <= '2026-12-31'
    spec = importlib.util.spec_from_file_location('khh_parser', 'scripts/crawler/parse-kix-schedule-evidence.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    commands = json.loads(pathlib.Path(file).read_text(encoding='utf-8-sig'))
    html = next(c['data'] for c in commands if c.get('selector') == '#flight-results-wrapper')
    assert set(re.findall(r'outboundDate=(\d{4}-\d{2}-\d{2})', html)) == {date}
    parser = module.Parser(); parser.feed(html)
    rows = []
    for card in parser.root.find_all('flight-card-schedule'):
        if card.attrs.get('data-flight-type') != 'direct' or card.attrs.get('data-flight-airline') not in ['CI','CX','UO','TW','UA','TG','AK','FD','5J','Z2']:
            continue
        def text(cls):
            found = card.find_all(cls); assert len(found) == 1
            return ' '.join(found[0].text().split())
        assert re.findall(r'\(([A-Z]{3})\)', text('flight-card-port-name')) == ['KHH', airport]
        number = re.match(r'([A-Z0-9]{2})(\d+)([A-Z]?)', text('flight-card-port-code'))
        assert number and number[1] == card.attrs['data-flight-airline']
        duration = re.fullmatch(r'(\d+)h\s*(\d+)m', text('flight-card-time-pass')); assert duration
        minutes = int(duration[1]) * 60 + int(duration[2]); assert 0 < minutes < 720
        clock = text('flight-card-time-dep'); assert re.fullmatch(r'\d{2}:\d{2}', clock)
        dep = dt.datetime.fromisoformat(f'{date}T{clock}:00').replace(tzinfo=ZoneInfo('Asia/Taipei'))
        arr = (dep.astimezone(dt.timezone.utc) + dt.timedelta(minutes=minutes)).astimezone(ZoneInfo(zones[airport]))
        published_arrival = text('flight-card-time-arr')
        assert re.search(r'\d{2}:\d{2}', published_arrival)[0] == arr.strftime('%H:%M')
        day_marker = re.search(r'\+(\d+)', published_arrival)
        if day_marker: assert (arr.date()-dep.date()).days == int(day_marker[1])
        rows.append({'origin':'KHH','date':date,'number':number[1]+str(int(number[2]))+number[3],
                     'airport':airport,'departure':dep.isoformat(),'arrival':arr.isoformat(),'minutes':minutes})
    print(json.dumps(rows, ensure_ascii=False))
elif mode == 'eva':
    spec = importlib.util.spec_from_file_location('eva_parser', 'scripts/crawler/fetch-eva-form.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    parser = module.DetailPage()
    parser.feed(pathlib.Path(file).read_text(encoding='utf-8-sig'))
    assert parser.regions == 1
    print(json.dumps({'text': ''.join(parser.parts).strip()}, ensure_ascii=False))
elif mode == 'jta':
    from html.parser import HTMLParser
    class Tables(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.tables, self.table, self.row, self.cell = [], None, None, None
        def handle_starttag(self, tag, attrs):
            if tag == 'table':
                assert self.table is None
                self.table = []
            if self.table is not None and tag == 'tr': self.row = []
            if self.row is not None and tag in ['td', 'th']: self.cell = []
            if self.cell is not None and tag == 'br': self.cell.append(' ')
        def handle_data(self, data):
            if self.cell is not None: self.cell.append(data)
        def handle_endtag(self, tag):
            if tag in ['td', 'th'] and self.cell is not None:
                self.row.append(''.join(self.cell))
                self.cell = None
            if tag == 'tr' and self.row is not None:
                self.table.append(self.row)
                self.row = None
            if tag == 'table' and self.table is not None:
                self.tables.append(self.table)
                self.table = None
    parser = Tables()
    parser.feed(pathlib.Path(file).read_text(encoding='utf-8-sig'))
    print(json.dumps(parser.tables, ensure_ascii=False))
else:
    raise ValueError('Unreviewed parser mode')
