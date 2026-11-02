"""Resolve research-only timezone gaps from the project's existing public dataset."""
import csv
import hashlib
import json
from pathlib import Path

root = Path('data/source-samples/crawler/tigerair-research-20261013')
raw = (root / 'openflights-airports.dat').read_bytes()
receipt = json.loads((root / 'openflights-airports.dat.receipt.json').read_text())
assert receipt['status'] == 200 and hashlib.sha256(raw).hexdigest() == receipt['sha256']
wanted = {'AXT', 'KCZ', 'OIT', 'HNA'}
rows = [row for row in csv.reader(raw.decode('utf-8').splitlines()) if row[4] in wanted]
assert len(rows) == 4 and {r[4] for r in rows} == wanted
assert all(row[3] == 'Japan' and row[11] == 'Asia/Tokyo' for row in rows)
evidence = {'sourceUrl': receipt['url'], 'retrievedAt': receipt['fetchedAt'],
            'sha256': receipt['sha256'], 'researchOnly': True,
            'airports': [{'code': r[4], 'name': r[1], 'country': r[3],
                          'timeZone': r[11], 'latitude': r[6], 'longitude': r[7]} for r in rows]}
with (root / 'additional-timezones.json').open('x', encoding='utf-8') as out:
    json.dump(evidence, out, ensure_ascii=False, indent=2)
print(json.dumps(evidence, ensure_ascii=False, indent=2))
