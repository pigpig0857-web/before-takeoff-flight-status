"""Compare saved, date-specific official tables with quarantined PDF rows.

Never fetches, infers operation dates, overwrites source evidence, or imports.
"""
import hashlib
import json
import re
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path('data/source-samples/crawler/ci-tpe-20261021')
OUT = ROOT / 'recheck-20261027'
load = lambda p: json.loads(p.read_text(encoding='utf-8-sig'))


class Node:
    def __init__(self, tag='', attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []

    def text(self):
        return ' '.join(c.text() if isinstance(c, Node) else c for c in self.children)

    def find(self, tag=None, cls=None):
        result = []
        for c in self.children:
            if isinstance(c, Node):
                if (tag is None or c.tag == tag) and (cls is None or cls in c.attrs.get('class', '').split()):
                    result.append(c)
                result.extend(c.find(tag, cls))
        return result


class TableParser(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.root = Node()
        self.stack = [self.root]
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        n = Node(tag, attrs)
        self.stack[-1].children.append(n)
        if tag not in ('br', 'img', 'input', 'hr', 'meta', 'link'):
            self.stack.append(n)

    def handle_endtag(self, tag):
        for i in range(len(self.stack)-1, 0, -1):
            if self.stack[i].tag == tag:
                self.stack = self.stack[:i]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


MONTH = {'十月': 10, '十一月': 11, '十二月': 12}
def parse_table(file, receipt):
    html = load(file)[0]  # Desktop table: header dates and aligned availability cells.
    rows = TableParser(html).root.find('tr')
    dates = []
    for cell in rows[0].find('th'):
        m = re.search(r'星期.\s+(\d{2})\s+(十[一二]?月)\s+(2026)', cell.text())
        assert m, (file, cell.text())
        dates.append(f'{m[3]}-{MONTH[m[2]]:02}-{m[1]}')
    assert len(dates) == 8 and len(set(dates)) == 8
    assert dates[3] == receipt['center'], (file, dates, receipt)
    results = []
    for row in rows[1:]:
        text = row.text()
        if '直飛航班' not in text:
            continue
        nums = re.findall(r'\(CI\s+(\d+)\)', text)
        if len(nums) != 1:
            continue
        origin = row.find(cls='citycode-from')[0].text().strip(' ()')
        destination = row.find(cls='citycode-to')[0].text().strip(' ()')
        if (origin, destination) != (receipt['from'], receipt['to']):
            continue  # City search may include TSA; do not count it as TPE.
        dep = row.find(cls='time-from')[0].text().strip()
        arr = row.find(cls='time-to')[0].text().strip()
        dm = re.search(r'(\d+)h(\d+)m', row.find(cls='duration')[0].text())
        assert dm
        minutes = int(dm[1])*60+int(dm[2])
        cells = row.find('td')
        assert len(cells) == len(dates)
        for day, cell in zip(dates, cells):
            status = cell.text().strip()
            assert status in ('適用', '未提供'), (file, status)
            if status != '適用' or day != receipt['center']:
                continue  # This bounded audit targets the nine specified Fridays only.
            departure, arrival = [f'{day}T{t}:00+08:00' for t in (dep, arr)]
            assert (datetime.fromisoformat(arrival)-datetime.fromisoformat(departure)).total_seconds()/60 == minutes
            operator = re.search(r'由\s+(.+?)\s+承運', text)
            assert operator
            results.append(dict(date=day, number='CI'+nums[0], origin=origin, destination=destination,
                                departure=departure, arrival=arrival, minutes=minutes,
                                operatingAirline=' '.join(operator[1].split()),
                                evidence=str(file), evidenceSha256=hashlib.sha256(file.read_bytes()).hexdigest(),
                                receipt=receipt))
    return results


if __name__ == '__main__':
    observations, receipts = [], []
    for file in sorted((OUT / 'browser').glob('*.receipt.json')):
        r = load(file)
        ax = file.with_name(file.name.replace('.receipt.json', '.ax.txt'))
        assert hashlib.sha256(ax.read_bytes()).hexdigest() == r['sha256']
        observations.extend(parse_table(file.with_name(file.name.replace('.receipt.json', '.tables.json')), r))
        receipts.append(r)
    assert len(receipts) == 27
    key = lambda r: '|'.join(r[k] for k in ('date', 'number', 'origin', 'destination'))
    indexed = {key(r): r for r in observations}
    pending = load(OUT / 'pending-duration-differences.json')
    comparisons, confirmed, unresolved = [], [], []
    for pdf in pending:
        if pdf['airlineCode'] != 'CI':
            continue
        ui = indexed.get(key(pdf))
        assert ui, key(pdf)
        assert ui['operatingAirline'] == pdf['operatingAirline']
        same = all(ui[f] == pdf[f] for f in ('departure', 'arrival', 'minutes'))
        comparisons.append(dict(identity=key(pdf), pdf=pdf, datedOfficialTable=ui,
                                status='clocks_confirmed_heading_duration_difference' if same else 'official_sources_clock_conflict',
                                overwriteExisting=False))
        if same:
            row = dict(pdf, requiresReview=False, confirmation=ui,
                       reviewDecision='Dated official table confirms printed clocks and calculated duration; retain PDF heading difference.')
            confirmed.append(row)
        else:
            unresolved.append(comparisons[-1])
    assert len(comparisons) == 27
    old = load(ROOT / 'consolidated-candidates.json')['groups']
    old_keys = {r['identity'] for r in old}
    accepted = load(OUT / 'ci-candidates.json')['records'] + confirmed
    fresh_keys = {key(r) for r in accepted} - old_keys
    report = dict(checkedAt=datetime.now(timezone.utc).isoformat(), baselineUniqueCIIdentities=len(old_keys),
                  savedOfficialWeeklyTables=len(receipts), comparedCIIdentities=len(comparisons),
                  confirmedClockIdentities=len(confirmed), unresolvedClockConflicts=len(unresolved),
                  newAcceptedCIIdentities=len(fresh_keys), combinedAcceptedCIIdentities=len(old_keys)+len(fresh_keys),
                  relatedAEAcceptedIdentities=292, relatedAEPendingIdentities=sum(r['airlineCode']=='AE' for r in pending),
                  integratedIntoWebsite=False, sourceEvidencePreserved=True,
                  baselineSha256=hashlib.sha256((ROOT/'consolidated-candidates.json').read_bytes()).hexdigest())
    for name, value in [('dated-official-observations.json', observations), ('duration-comparisons.json', comparisons),
                        ('unresolved-clock-conflicts.json', unresolved), ('confirmed-ci-extension.json', {'records': accepted}),
                        ('dated-audit.json', report)]:
        (OUT/name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
