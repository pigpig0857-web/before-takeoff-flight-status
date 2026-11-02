/** Bounded anonymous public form submission; no redirects or challenge bypass. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const date = option('--date');
const python = option('--python');
const output = option('--output-dir');
const arrival = args.includes('--arrival') ? option('--arrival') : 'NRT';
const rangeRequested = args.includes('--from') || args.includes('--through');
if (
  rangeRequested &&
  (!args.includes('--from') ||
    !args.includes('--through') ||
    args.includes('--collect-week') ||
    args.includes('--capture-details') ||
    !args.includes('--collect-details'))
)
  throw new Error(
    'Range requires --from, --through and --collect-details only',
  );
if (
  rangeRequested &&
  [option('--from'), option('--through')].some(
    (d) =>
      !/^\d{4}-\d{2}-\d{2}$/.test(d ?? '') ||
      !Number.isFinite(Date.parse(d)) ||
      new Date(d).toISOString().slice(0, 10) !== d,
  )
)
  throw new Error('Invalid range date');
// Values observed in the official page's public airport-cache list.
const airportValues = {
  NRT: 'TYONRT',
  ICN: 'SELICN',
  BKK: 'BKKBKK',
  SFO: 'SFOSFO',
};
const researchAirportValues = { KIX: 'OSAKIX', LAX: 'LAXLAX' };
const airportSelection =
  airportValues[arrival] ??
  (args.includes('--capture-details')
    ? researchAirportValues[arrival]
    : undefined);
if (!airportSelection) throw new Error('Unreviewed airport selection');
if (
  !args.includes('--date') ||
  !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ||
  !args.includes('--python') ||
  !args.includes('--output-dir')
)
  throw new Error(
    'Required: --date YYYY-MM-DD --python PATH --output-dir PATH',
  );
if (
  !Number.isFinite(Date.parse(date)) ||
  new Date(date).toISOString().slice(0, 10) !== date
)
  throw new Error('Invalid calendar date');
const root = path.resolve('data/source-samples/crawler');
const directory = path.resolve(output);
const relative = path.relative(root, directory);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
  throw new Error('Output must be a new directory within crawler samples');
await fs.mkdir(path.dirname(directory), { recursive: true });
await fs.mkdir(directory); // Never overwrite an earlier observation.
const sourceUrl =
  'https://booking.evaair.com/flyeva/eva/b2c/flight-schedules.aspx?lang=en-hk';
const report = {
  startedAt: new Date().toISOString(),
  sourceUrl,
  query: { departure: 'TPE', arrival, date },
  mode: 'ordinary_http_form_node',
  browserUsed: false,
  requests: [],
  status: 'running',
  flightQuerySubmitted: false,
};
await fs.writeFile(
  path.join(directory, 'receipt.json'),
  JSON.stringify(report, null, 2),
);
const cookies = new Map(); // Anonymous cookies issued in this run only.
const parse = (file) =>
  JSON.parse(
    execFileSync(
      python,
      ['scripts/crawler/fetch-eva-form.py', '--parse-file', file],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 4_000_000 },
    ),
  );
const validate = (mode) => {
  try {
    return JSON.parse(
      execFileSync(
        process.execPath,
        [
          'node_modules/tsx/dist/cli.mjs',
          'scripts/crawler/validate-eva-http.ts',
          '--sample-dir',
          directory,
          '--date',
          date,
          '--python',
          python,
          '--mode',
          mode,
          '--arrival',
          arrival,
          ...(args.includes('--collect-week') ? ['--all-week'] : []),
          ...(args.includes('--from') ? ['--from', option('--from')] : []),
          ...(args.includes('--through')
            ? ['--through', option('--through')]
            : []),
        ],
        { encoding: 'utf8', timeout: 20_000, maxBuffer: 4_000_000 },
      ),
    );
  } catch (error) {
    throw new Error(
      error.stderr?.toString().trim().slice(0, 500) || error.message,
    );
  }
};
async function request(url, filename, fields) {
  const target = new URL(url);
  if (
    target.origin !== new URL(sourceUrl).origin ||
    ![
      '/flyeva/eva/b2c/flight-schedules.aspx',
      '/flyeva/eva/b2c/flight-details.aspx',
    ].includes(target.pathname.toLowerCase()) ||
    (fields &&
      target.pathname.toLowerCase() !== '/flyeva/eva/b2c/flight-schedules.aspx')
  )
    throw new Error('Unreviewed form destination');
  const attempt = {
    method: fields ? 'POST' : 'GET',
    status: 'started',
    path: target.pathname,
    savedFile: filename,
  };
  report.requests.push(attempt);
  if (fields) report.flightQuerySubmitted = true;
  const start = performance.now();
  try {
    const headers = {
      'User-Agent':
        'FlightStatusResearch/0.1 (local schedule feasibility test)',
      Accept: 'text/html',
    };
    if (fields) headers.Referer = sourceUrl;
    if (cookies.size)
      headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await fetch(url, {
      method: attempt.method,
      headers,
      body: fields ? new URLSearchParams(fields) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    attempt.httpStatus = response.status;
    const location = response.headers.get('location');
    if (location) {
      const redirect = new URL(location, url);
      attempt.redirect = { origin: redirect.origin, path: redirect.pathname };
    }
    if (
      response.status !== 200 ||
      !response.headers.get('content-type')?.includes('text/html')
    ) {
      await response.body?.cancel();
      throw new Error(
        `HTTP ${response.status}; redirects and verification not followed`,
      );
    }
    for (const value of response.headers.getSetCookie()) {
      const [pair] = value.split(';');
      const equal = pair.indexOf('=');
      if (equal > 0) cookies.set(pair.slice(0, equal), pair.slice(equal + 1));
    }
    const chunks = [];
    let bytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 2_000_000) throw new Error('HTML exceeds limit');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const body = Buffer.concat(chunks);
    attempt.bytes = bytes;
    attempt.sha256 = createHash('sha256').update(body).digest('hex');
    const file = path.join(directory, filename);
    await fs.writeFile(file, body);
    attempt.status = 'received';
    return parse(file);
  } catch (error) {
    attempt.status = 'failed';
    throw error;
  } finally {
    attempt.elapsedMs = Math.round(performance.now() - start);
    attempt.finishedAt = new Date().toISOString();
    await fs.writeFile(
      path.join(directory, 'receipt.json'),
      JSON.stringify(report, null, 2),
    );
  }
}
try {
  const page = await request(sourceUrl, 'form.html');
  if (!page.action || !Object.hasOwn(page.fields, 'ctl00$__MasterEVENTTARGET'))
    throw new Error('Missing observed public form');
  const bounds = page.inputs.content_txt_tbGo2YYYYMM;
  if (!bounds?.min || !bounds?.max || date < bounds.min || date > bounds.max)
    throw new Error('Missing date bounds or query outside published bounds');
  report.publishedDateMin = bounds.min;
  report.publishedDateMax = bounds.max;
  if (
    rangeRequested &&
    (option('--from') < bounds.min || option('--through') > bounds.max)
  )
    throw new Error('Range outside published bounds');
  const changes = {
    ctl00$__MasterEVENTTARGET: 'ctl00$content$btn_ok',
    ctl00$__MasterEVENTARGUMENT: '',
    ctl00$content$rbn_Segment1: 'ONE_WAY',
    // Actual values from the page's public airport list and city widget.
    // The first three characters are the city; the final three are the airport.
    ctl00$content$hid_Dep: 'TPETPE',
    ctl00$content$hid_Arr: airportSelection,
    ctl00$content$txt_formcity: 'TPETPE',
    ctl00$content$txt_tocity: airportSelection,
    ctl00$content$txt_tbGoYYYYMM: date,
    ctl00$content$txt_tbGo2YYYYMM: date,
  };
  if (Object.keys(changes).some((key) => !Object.hasOwn(page.fields, key)))
    throw new Error('Changed form fields; submission cancelled');
  await delay(1500);
  const result = await request(
    new URL(page.action, sourceUrl).href,
    'search.html',
    { ...page.fields, ...changes },
  );
  if (!result.rows.length)
    throw new Error('No verified schedule table; not proof of no flights');
  await fs.writeFile(
    path.join(directory, 'week.json'),
    JSON.stringify(
      {
        sourceUrl,
        capturedAt: new Date().toISOString(),
        query: report.query,
        rows: result.rows,
      },
      null,
      2,
    ),
  );
  report.observedRows = result.rows.length;
  if (args.includes('--collect-details') || args.includes('--collect-week'))
    report.observedDates = validate('window');
  report.status = 'schedule_table_received_not_yet_validated';
  if (args.includes('--capture-details')) {
    // Research-only capture of links for one date; never mark these as verified.
    const stamp = `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;
    const candidates = result.rows.flatMap((row) =>
      row.cells
        .filter(
          (cell) =>
            cell.detailLink &&
            new URL(cell.detailLink, sourceUrl).searchParams.get('Week_DT') ===
              stamp,
        )
        .map((cell) => ({
          header: row.header,
          dateLabel: cell.dateLabel,
          detailLink: cell.detailLink,
        })),
    );
    if (!candidates.length || candidates.length > 10)
      throw new Error('Missing or excessive research details');
    const captures = [];
    for (const candidate of candidates) {
      await delay(1500);
      const file = `detail-${captures.length + 1}.html`;
      await request(new URL(candidate.detailLink, sourceUrl).href, file);
      captures.push({
        ...candidate,
        htmlFile: file,
        capturedAt: new Date().toISOString(),
      });
    }
    await fs.writeFile(
      path.join(directory, 'research-manifest.json'),
      JSON.stringify(captures, null, 2),
    );
    report.detailsReceived = captures.length;
    report.status = 'research_details_received_not_validated';
  } else if (
    args.includes('--collect-details') ||
    args.includes('--collect-week')
  ) {
    // Validate dates, reviewed route, service symbols and exact source links before more requests.
    const candidates = validate('plan');
    const details = [];
    for (const candidate of candidates) {
      await delay(1500);
      const file = `detail-${details.length + 1}.html`;
      await request(new URL(candidate.detailLink, sourceUrl).href, file);
      details.push({
        ...candidate,
        htmlFile: file,
        capturedAt: new Date().toISOString(),
      });
      report.detailsReceived = details.length;
      await fs.writeFile(
        path.join(directory, 'details-manifest.json'),
        JSON.stringify(details, null, 2),
      );
    }
    await fs.writeFile(
      path.join(directory, 'details-manifest.json'),
      JSON.stringify(details, null, 2),
    );
    report.detailsReceived = details.length;
    Object.assign(report, validate('validate'));
    report.status = 'verified_requested_scope';
  }
} catch (error) {
  report.status = 'failed';
  report.error = error.message.slice(0, 800);
  process.exitCode = 1;
}
report.finishedAt = new Date().toISOString();
await fs.writeFile(
  path.join(directory, 'receipt.json'),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
