"""Read-only parser for saved anonymous Kansai Airport timetable responses."""
import hashlib
import json
import re
from html.parser import HTMLParser
from zoneinfo import ZoneInfo
import datetime as dt

class Node:
    def __init__(self, tag='', attrs=None):
        self.tag = tag
        self.attrs = dict(attrs or [])
        self.children = []

    def text(self):
        return ''.join(c if isinstance(c, str) else c.text() for c in self.children)

    def find_all(self, cls):
        found = []
        for child in self.children:
            if isinstance(child, Node):
                if cls in child.attrs.get('class', '').split():
                    found.append(child)
                found.extend(child.find_all(cls))
        return found

class Parser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']:
            self.stack.append(node)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                self.stack = self.stack[:index]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)

def parse_saved(body_path, date):
    receipt_path = body_path.with_suffix('.receipt.json')
    receipt = json.loads(receipt_path.read_text(encoding='utf-8-sig'))
    content = body_path.read_bytes()
    assert receipt['status'] == 200 and hashlib.sha256(content).hexdigest() == receipt['sha256']
    commands = json.loads(content)
    result = next(c for c in commands if c.get('command') == 'insert' and c.get('selector') == '#flight-results-wrapper')
    assert set(re.findall(r'outboundDate=(\d{4}-\d{2}-\d{2})', result['data'])) == {date}
    parser = Parser()
    parser.feed(result['data'])
    cards = parser.root.find_all('flight-card-schedule')
    records = []
    for index, card in enumerate(cards):
        if card.attrs.get('data-flight-type') != 'direct' or card.attrs.get('data-flight-airline') != 'GK':
            continue
        route = card.find_all('flight-card-port-name')[0].text().strip()
        assert '(TPE)' in route and '(KIX)' in route and route.index('(TPE)') < route.index('(KIX)')
        number = re.search(r'GK\d+', card.find_all('flight-card-port-code')[0].text()).group()
        assert number in ['GK50', 'GK54']
        departure_text = card.find_all('flight-card-time-dep')[0].text().strip()
        arrival_text = card.find_all('flight-card-time-arr')[0].text().strip()
        assert re.fullmatch(r'\d{2}:\d{2}', departure_text)
        assert re.fullmatch(r'\d{2}:\d{2}', arrival_text), 'Arrival date needs explicit review'
        duration = card.find_all('flight-card-time-pass')[0].text().strip()
        match = re.fullmatch(r'(\d+)h\s*(\d+)m', duration)
        assert match, duration
        minutes = int(match[1]) * 60 + int(match[2])
        departure = dt.datetime.fromisoformat(f'{date}T{departure_text}:00').replace(tzinfo=ZoneInfo('Asia/Taipei'))
        arrival = dt.datetime.fromisoformat(f'{date}T{arrival_text}:00').replace(tzinfo=ZoneInfo('Asia/Tokyo'))
        assert (arrival - departure).total_seconds() == minutes * 60
        records.append({'number': number, 'date': date, 'origin': 'TPE', 'airport': 'KIX',
                        'departure': departure.isoformat(), 'arrival': arrival.isoformat(),
                        'arrivalTimeZone': 'Asia/Tokyo', 'minutes': minutes,
                        'evidence': {'file': str(body_path), 'sha256': receipt['sha256'],
                                     'sourceUrl': receipt['url'], 'query': {'from': 'TPE', 'to': 'KIX', 'date': date},
                                     'cardIndex': index, 'method': 'ordinary_public_timetable_form',
                                     'providerDisclosure': 'Kansai Airports public schedule supplied by OAG'},
                        'fetchedAt': receipt['fetchedAt']})
    assert len({(r['date'], r['number']) for r in records}) == len(records)
    return records

if __name__ == '__main__':
    import pathlib
    root = pathlib.Path('data/source-samples/crawler/jta-jetstar-completeness-20261014')
    for date in ['2026-10-14', '2026-10-25', '2026-11-24']:
        print(json.dumps(parse_saved(root / 'kix-daily' / f'kix-tpe-kix-{date}.body', date), ensure_ascii=False))
