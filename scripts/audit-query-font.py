"""Offline checks for licensed real-weight fonts and complete, disjoint coverage."""
import hashlib
import json
from pathlib import Path
import re
import sys

from fontTools.ttLib import TTFont

if '--rounded' not in sys.argv:
    notice = json.loads(Path('public/fonts/NOTICE.json').read_text(encoding='utf-8'))
    path = Path('public/fonts/FlightQuerySans.woff2')
    assert notice['family'] == 'Noto Sans TC'
    assert hashlib.sha256(path.read_bytes()).hexdigest() == notice['sha256']
    font = TTFont(path)
    assert len(font.getBestCmap()) == notice['glyphs']
    assert any(axis.axisTag == 'wght' and axis.minValue == 100 and axis.maxValue == 900
               for axis in font['fvar'].axes)
    layout = Path('src/app/layout.tsx').read_text(encoding='utf-8')
    assert "FlightQuerySans.woff2" in layout and "rounded-font-fallback.css" not in layout
    print(json.dumps({'family': notice['family'], 'glyphs': notice['glyphs'],
                      'bytes': notice['bytes'], 'weightRange': notice['weightRange']}))
    sys.exit(0)

notice = json.loads(Path('public/fonts/rounded/NOTICE.json').read_text(encoding='utf-8'))
css = Path('src/app/rounded-font-fallback.css').read_text(encoding='utf-8')
assert notice['weights'] == [400, 500, 700]
report = {'assets': len(notice['assets']), 'coreBytes': notice['coreBytes'], 'weights': {}}
for weight, suffix in {400: 'R', 500: 'M', 700: 'B'}.items():
    coverage = set()
    for asset in (a for a in notice['assets'] if a['weight'] == weight):
        path = Path('public/fonts') / asset['file']
        assert hashlib.sha256(path.read_bytes()).hexdigest() == asset['sha256'], path
        font = TTFont(path)
        assert font['OS/2'].usWeightClass == weight and 'fvar' not in font, path
        points = set(font.getBestCmap())
        assert len(points) == asset['glyphs'], path
        assert not coverage.intersection(points), path
        coverage.update(points)
        if not path.name.endswith('-core.woff2'):
            rule = next(rule for rule in css.split('@font-face') if path.name in rule)
            assert re.search(rf'font-weight:\s*{weight};', rule), path
            specified = set()
            for start, end in re.findall(r'U\+([0-9A-F]+)(?:-([0-9A-F]+))?', rule):
                specified.update(range(int(start, 16), int(end or start, 16) + 1))
            assert specified == points, path
        font.close()
    source = TTFont(f'data/cache/font-build/gensen/GenSenRounded2TW-{suffix}.otf')
    assert coverage == set(source.getBestCmap())
    source.close()
    report['weights'][weight] = len(coverage)
    print(f'Validated {weight}: {len(coverage)} characters', flush=True)
for path in map(Path, ['src/app/globals.css', 'src/app/typography.css', 'src/app/flight-cards.css']):
    content = path.read_text(encoding='utf-8')
    assert set(re.findall(r'font-weight:\s*(\d+)', content)) <= {'400', '500', '700'}, path
    assert not re.search(r'transform:\s*scale', content), path
assert 'font-synthesis: none' in Path('src/app/globals.css').read_text(encoding='utf-8')
assert Path('public/fonts/GenSenRounded-OFL.txt').read_bytes() == Path('data/cache/font-build/gensen/OFL.txt').read_bytes()
print(json.dumps(report))
