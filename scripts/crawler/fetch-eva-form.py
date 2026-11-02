"""Bounded ordinary EVA public WebForms query. No browser, login or challenge bypass."""
import argparse
import hashlib
import http.cookiejar
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

SOURCE = 'https://booking.evaair.com/flyeva/eva/b2c/flight-schedules.aspx?lang=en-hk'
LIMIT = 2_000_000

class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.fields, self.inputs, self.rows = {}, {}, []
        self.action = None
        self.row = self.cell = None
        self.header_depth = 0
        self.header_text = []

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == 'form' and attrs.get('id') == 'User_Page':
            self.action = attrs.get('action')
        if tag == 'input':
            self.inputs[attrs.get('id')] = attrs
            kind, name = attrs.get('type', 'text'), attrs.get('name')
            if name and (kind not in ('radio', 'checkbox') or 'checked' in attrs):
                self.fields[name] = attrs.get('value', '')
        if tag == 'tr' and 'table-dataRow--schedule' in attrs.get('class', '').split():
            if self.row is not None:
                raise ValueError('Nested schedule row')
            self.row = {'header': '', 'cells': []}
        if self.row is not None:
            if tag == 'th':
                self.header_depth += 1
                self.header_text = []
            if tag == 'td':
                self.cell = {'dateLabel': attrs.get('aria-label'), 'detailLink': None, 'carrierImage': None}
            if tag == 'a' and self.cell is not None:
                if self.cell['detailLink'] is not None:
                    raise ValueError('Multiple detail links in one day')
                self.cell['detailLink'] = attrs.get('href')
            if tag == 'img' and self.cell is not None:
                self.cell['carrierImage'] = attrs.get('src')

    def handle_data(self, data):
        if self.header_depth:
            self.header_text.append(data)

    def handle_endtag(self, tag):
        if self.row is None:
            return
        if tag == 'th' and self.header_depth:
            self.header_depth -= 1
            self.row['header'] = ''.join(self.header_text).strip()
            # Whitespace in source indentation does not separate flight legs.
            self.row['header'] = ''.join(self.row['header'].split())
        if tag == 'td' and self.cell is not None:
            self.row['cells'].append(self.cell)
            self.cell = None
        if tag == 'tr':
            self.rows.append(self.row)
            self.row = None

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None

class DetailPage(HTMLParser):
    """Read only the published detail region; exclude hidden error text and scripts."""
    VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
    BLOCK = {'div', 'p', 'h1', 'h2', 'h3', 'li', 'ul', 'section'}
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.parts, self.regions = [], [], 0

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        parent = self.stack[-1] if self.stack else {'active': False, 'hidden': False}
        region = 'div_detail' in attrs.get('class', '').split()
        if region:
            self.regions += 1
        hidden = parent['hidden'] or 'hidden' in attrs or attrs.get('aria-hidden') == 'true' or bool(re.search(r'(?:^|;)\s*display\s*:\s*none\b', attrs.get('style', ''), re.I)) or tag in {'script', 'style'}
        separator = tag in self.BLOCK or tag == 'br' or 'display-block' in attrs.get('class', '').split()
        if (parent['active'] or region) and not hidden and separator:
            self.parts.append(' ')
        if tag not in self.VOID:
            self.stack.append({'tag': tag, 'active': parent['active'] or region, 'hidden': hidden, 'separator': separator})

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index]['tag'] == tag:
                item = self.stack[index]
                if item['active'] and not item['hidden'] and item['separator']:
                    self.parts.append(' ')
                del self.stack[index:]
                break

    def handle_data(self, data):
        if self.stack and self.stack[-1]['active'] and not self.stack[-1]['hidden']:
            self.parts.append(data)

    def result(self):
        if self.regions != 1:
            raise ValueError('Missing or ambiguous public detail region')
        return {'detailText': re.sub(r'\s+', ' ', ''.join(self.parts)).strip()}

def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--date')
    parser.add_argument('--output-dir')
    parser.add_argument('--parse-file')
    parser.add_argument('--parse-detail-file')
    parser.add_argument('--parse-detail-batch')
    parser.add_argument('--parse-airports-file')
    args = parser.parse_args()
    if args.parse_detail_batch:
        source_root = Path('data/source-samples/crawler').resolve()
        files = json.loads(Path(args.parse_detail_batch).read_text(encoding='utf-8-sig'))
        results = {}
        for filename in files:
            file = Path(filename).resolve()
            if not file.is_relative_to(source_root):
                raise ValueError('Detail batch file outside source directory')
            page = DetailPage()
            page.feed(file.read_text(encoding='utf-8-sig'))
            results[filename] = page.result()
        print(json.dumps(results))
        return 0
    if args.parse_airports_file:
        root = ET.parse(args.parse_airports_file).getroot()
        if root.tag != 'airports':
            raise ValueError('Unknown airport list')
        items = [{key: item.findtext(key) for key in ['chinese', 'label', 'value', 'region']} for item in root.findall('airport')]
        if not items or any(not re.fullmatch('[A-Z]{6}', item['value'] or '') or not item['label'] for item in items) or len({item['value'] for item in items}) != len(items):
            raise ValueError('Invalid airport list')
        print(json.dumps({'airports': items}))
        return 0
    if args.parse_detail_file:
        page = DetailPage()
        page.feed(Path(args.parse_detail_file).read_text(encoding='utf-8-sig'))
        print(json.dumps(page.result()))
        return 0
    if args.parse_file:
        page = Page()
        page.feed(Path(args.parse_file).read_text(encoding='utf-8-sig'))
        # Transport helper: consumed privately by Node, never printed to task logs.
        print(json.dumps({'action': page.action, 'fields': page.fields, 'inputs': page.inputs, 'rows': page.rows}))
        return 0
    if not args.date or not args.output_dir:
        parser.error('--date and --output-dir are required for network mode')
    datetime.strptime(args.date, '%Y-%m-%d')
    root = Path('data/source-samples/crawler').resolve()
    destination = Path(args.output_dir).resolve()
    if not destination.is_relative_to(root):
        raise ValueError('Output must stay within crawler sample directory')
    destination.mkdir(parents=True, exist_ok=False)
    report = {'startedAt': iso_now(), 'sourceUrl': SOURCE, 'query': {'departure': 'TPE', 'arrival': 'NRT', 'date': args.date},
              'mode': 'ordinary_http_form', 'requests': [], 'status': 'running', 'browserUsed': False,
              'flightQuerySubmitted': False}
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def request(url, name, fields=None):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'https' or parsed.netloc != 'booking.evaair.com':
            raise ValueError('Unknown form destination')
        data = urllib.parse.urlencode(fields).encode() if fields is not None else None
        req = urllib.request.Request(url, data=data, headers={
            'User-Agent': 'FlightStatusResearch/0.1 (local schedule feasibility test)',
            'Accept': 'text/html', 'Referer': SOURCE,
        })
        started = time.monotonic()
        attempt = {'method': 'POST' if fields is not None else 'GET', 'status': 'started'}
        report['requests'].append(attempt)
        if fields is not None:
            report['flightQuerySubmitted'] = True
        try:
            with opener.open(req, timeout=20) as response:
                attempt['httpStatus'] = response.status
                if response.status != 200 or 'text/html' not in response.headers.get('Content-Type', ''):
                    raise ValueError(f'Unexpected response HTTP {response.status}')
                body = response.read(LIMIT + 1)
                if len(body) > LIMIT:
                    raise ValueError('Oversized public HTML')
            attempt['status'] = 'received'
        except Exception as error:
            attempt['status'] = 'failed'
            if isinstance(error, urllib.error.HTTPError):
                attempt['httpStatus'] = error.code
            raise
        finally:
            attempt['elapsedMs'] = round((time.monotonic() - started) * 1000)
            attempt['finishedAt'] = iso_now()
        (destination / name).write_bytes(body)
        attempt.update({'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()})
        return body.decode('utf-8-sig')
    try:
        initial_html = request(SOURCE, 'form.html')
        page = Page(); page.feed(initial_html)
        if not page.action or 'ctl00$__MasterEVENTTARGET' not in page.fields:
            raise ValueError('Missing observed public WebForms inputs')
        departure_input = page.inputs.get('content_txt_tbGo2YYYYMM', {})
        if not departure_input.get('min') or not departure_input.get('max'):
            raise ValueError('Missing published date limits')
        report['publishedDateMin'] = departure_input['min']
        report['publishedDateMax'] = departure_input['max']
        if not departure_input['min'] <= args.date <= departure_input['max']:
            raise ValueError('Query outside published date range')
        fields = page.fields.copy()
        values = {
            'ctl00$__MasterEVENTTARGET': 'ctl00$content$btn_ok',
            'ctl00$__MasterEVENTARGUMENT': '',
            'ctl00$content$rbn_Segment1': 'ONE_WAY',
            # Public airport-cache values confirmed in the normal city selector.
            'ctl00$content$hid_Dep': 'TPETPE', 'ctl00$content$hid_Arr': 'TYONRT',
            'ctl00$content$txt_formcity': 'TPETPE', 'ctl00$content$txt_tocity': 'TYONRT',
            'ctl00$content$txt_tbGoYYYYMM': args.date, 'ctl00$content$txt_tbGo2YYYYMM': args.date,
        }
        if any(name not in fields for name in values):
            raise ValueError('Changed form fields; do not invent a submission')
        fields.update(values)
        time.sleep(1.5)
        result = request(urllib.parse.urljoin(SOURCE, page.action), 'search.html', fields)
        results = Page(); results.feed(result)
        if not results.rows:
            raise ValueError('Form returned no verified schedule table; not proof of no flights')
        report['status'] = 'schedule_table_received_not_yet_validated'
        report['observedRows'] = len(results.rows)
        (destination / 'week.json').write_text(json.dumps({'capturedAt': iso_now(), 'sourceUrl': SOURCE,
            'query': report['query'], 'rows': results.rows}, ensure_ascii=False, indent=2), encoding='utf-8')
    except Exception as error:
        report['status'] = 'failed'
        if isinstance(error, urllib.error.HTTPError):
            target = error.headers.get('Location')
            redirect = urllib.parse.urlsplit(urllib.parse.urljoin(SOURCE, target)) if target else None
            report['error'] = f'HTTP {error.code}; redirect not followed'
            report['redirect'] = {'origin': f'{redirect.scheme}://{redirect.netloc}', 'path': redirect.path} if redirect else None
        else:
            report['error'] = str(error)[:800]
    report['finishedAt'] = iso_now()
    (destination / 'receipt.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report['status'] != 'failed' else 1

if __name__ == '__main__':
    raise SystemExit(main())
