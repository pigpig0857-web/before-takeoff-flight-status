"""Offline form and failure tests; simulated responses are not live observations."""
import importlib.util
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('eva_form', ROOT / 'scripts/crawler/fetch-eva-form.py')
eva = importlib.util.module_from_spec(spec)
spec.loader.exec_module(eva)


class FormTests(unittest.TestCase):
    def test_form_preserves_encoded_state_and_checked_radio(self):
        page = eva.Page()
        page.feed('''<form id="User_Page" action="./flight-schedules.aspx?lang=en-hk">
        <input name="__ZIPSTATE" value="a+b/c=&amp;d">
        <input type="radio" name="trip" value="ONE_WAY">
        <input type="radio" name="trip" value="ROUND_TRIP" checked>
        <input id="content_txt_tbGo2YYYYMM" type="date" min="2026-10-07" max="2027-10-02">
        </form>''')
        self.assertEqual(page.fields['__ZIPSTATE'], 'a+b/c=&d')
        self.assertEqual(page.fields['trip'], 'ROUND_TRIP')
        self.assertEqual(page.inputs['content_txt_tbGo2YYYYMM']['max'], '2027-10-02')

    def test_no_results_does_not_create_schedule_rows(self):
        page = eva.Page()
        page.feed('<form id="User_Page" action="./flight-schedules.aspx"><p>Timetables</p></form>')
        self.assertEqual(page.rows, [])

    def test_row_keeps_missing_service_and_decodes_public_link(self):
        page = eva.Page()
        page.feed('''<table><tr class="table-dataRow--schedule">
        <th>BR0184 TPE 07:55 NRT 12:00</th>
        <td aria-label="Dec. 30, 2026Wednesday"><a href="flight-details.aspx?Week_DT=12/30/2026&amp;other=x"><img src="BR.png"></a></td>
        <td aria-label="Dec. 31, 2026Thursday"></td></tr></table>''')
        self.assertEqual(page.rows[0]['header'], 'BR0184TPE07:55NRT12:00')
        self.assertIn('&other=x', page.rows[0]['cells'][0]['detailLink'])
        self.assertIsNone(page.rows[0]['cells'][1]['detailLink'])

    def test_ambiguous_multiple_details_rejected(self):
        page = eva.Page()
        with self.assertRaisesRegex(ValueError, 'Multiple detail links'):
            page.feed('<tr class="table-dataRow--schedule"><td><a href="a"></a><a href="b"></a></td></tr>')

    def test_detail_uses_visible_region_and_block_separators(self):
        page = eva.DetailPage()
        page.feed('''<header>Other flights</header><div class="div_detail"><h1>Flight details</h1>
        <div style="display: none">Error: no flights</div>
        <div><span>BR184</span>Operated By：EVA AIR</div>
        <div>Flight Time<span class="display-block">3 Hours 5 Minutes</span></div>
        <p>787-10<img alt="wifi"></p><a>seat maps</a><script>fake data</script></div>''')
        self.assertEqual(page.result()['detailText'], 'Flight details BR184Operated By：EVA AIR Flight Time 3 Hours 5 Minutes 787-10 seat maps')

    def test_missing_or_duplicate_detail_region_rejected(self):
        for html in ['<p>Flight details</p>', '<div class="div_detail"></div><div class="div_detail"></div>']:
            page = eva.DetailPage(); page.feed(html)
            with self.assertRaisesRegex(ValueError, 'Missing or ambiguous'):
                page.result()

    def test_refusal_is_counted_and_previous_observation_is_preserved(self):
        sample_root = ROOT / 'data/source-samples/crawler'
        sample_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='offline-eva-test-', dir=sample_root) as temp:
            base = Path(temp)
            previous = base / 'previous.json'
            previous.write_text('{"knownGood":true}', encoding='utf-8')
            original = previous.read_bytes()
            output = base / 'refused'
            error = urllib.error.HTTPError(eva.SOURCE, 403, 'Forbidden', {}, None)
            with patch('sys.argv', ['eva-form', '--date', '2026-12-30', '--output-dir', str(output)]), \
                 patch.object(eva.urllib.request, 'build_opener') as opener, \
                 patch('builtins.print'):
                opener.return_value.open.side_effect = error
                self.assertEqual(eva.main(), 1)
            report = json.loads((output / 'receipt.json').read_text(encoding='utf-8'))
            self.assertEqual(len(report['requests']), 1)
            self.assertEqual(report['requests'][0]['httpStatus'], 403)
            self.assertEqual(report['status'], 'failed')
            self.assertEqual(previous.read_bytes(), original)
            self.assertFalse((output / 'week.json').exists())


if __name__ == '__main__':
    unittest.main()
