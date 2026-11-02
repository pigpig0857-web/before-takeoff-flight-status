/** Fetch only public links declared by the reviewed alternative pages. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve(process.argv[2] || '');
if (path.dirname(root) !== path.resolve('data/source-samples/crawler'))
  throw new Error('Invalid evidence directory');
const caa = await fs.readFile(path.join(root, 'caa-open-data.html'), 'utf8');
const status = await fs.readFile(path.join(root, 'peach-status.html'), 'utf8');
const attachment = caa.match(
  /<a[^>]*href="([^"]+)"[^>]*title="國際及兩岸定期客運班表\.csv"/,
);
const module = status.match(
  /src="([^"<>]*\/peach_flightstatus\/js\/en-us\.js[^"<>]*)"/,
);
if (!attachment || !module) throw new Error('Public source link changed');
const airportStage = process.argv.includes('--airport-schedules');
const moduleStage = process.argv.includes('--airport-modules');
const dataStage = process.argv.includes('--airport-data');
const hanedaSource = dataStage
  ? await fs.readFile(path.join(root, 'haneda-flight-search.js'), 'utf8')
  : '';
const hanedaPath = dataStage
  ? hanedaSource.match(/month:\{[^}]*"int-arrival":"([^"]+)"/)?.[1]
  : null;
if (dataStage && !hanedaPath)
  throw new Error('Haneda monthly arrival source changed');
const targets = dataStage
  ? [
      [
        'naha-date-range.json',
        'https://www.naha-airport.co.jp/common/json/date_range.json',
      ],
      [
        'naha-arrivals.json',
        'https://www.naha-airport.co.jp/common/json/arrival_flight_schedule.json',
      ],
      [
        'haneda-month-arrivals.json',
        new URL(hanedaPath, 'https://tokyo-haneda.com').href,
      ],
    ]
  : moduleStage
    ? [
        [
          'naha-month-module.js',
          'https://www.naha-airport.co.jp/common/js/flight_month.js?ver=4.9.8',
        ],
        [
          'naha-month-run.js',
          'https://www.naha-airport.co.jp/common/js/flight_month_run.js?ver=4.9.8',
        ],
        [
          'haneda-flight-search.js',
          'https://tokyo-haneda.com/site_resource/flight/js/flightSearch.js?202609011400',
        ],
      ]
    : airportStage
      ? [
          [
            'peach-live.json',
            'https://www.flypeach.com/flight_status/api/get.php?lang=en',
          ],
          ['naha-monthly.html', 'https://www.naha-airport.co.jp/flight/month/'],
          [
            'haneda-monthly.html',
            'https://tokyo-haneda.com/flight/monthlyFlightSchedule.html',
          ],
        ]
      : [
          [
            'caa-foreign.csv',
            new URL(
              attachment[1].replaceAll('&amp;', '&'),
              'https://www.caa.gov.tw/article.aspx?a=294&lang=1',
            ).href,
          ],
          [
            'peach-status-module.js',
            new URL(module[1], 'https://www.flypeach.com').href,
          ],
          [
            'centrair-arrivals.html',
            'https://www.centrair.jp/flight/schedule/international-arrival-01.html?period=0',
          ],
        ];
const receiptFile = dataStage
  ? 'airport-data-receipt.json'
  : moduleStage
    ? 'airport-module-receipt.json'
    : airportStage
      ? 'airport-receipt.json'
      : 'details-receipt.json';
const report = {
  startedAt: new Date().toISOString(),
  sources: [],
  integratedIntoWebsite: false,
};
for (const [file, url] of targets) {
  const entry = { url, file, startedAt: new Date().toISOString() };
  report.sources.push(entry);
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
    entry.httpStatus = response.status;
    entry.contentType = response.headers.get('content-type');
    const chunks = [],
      reader = response.body.getReader();
    let size = 0;
    try {
      for (;;) {
        const p = await reader.read();
        if (p.done) break;
        size += p.value.length;
        if (size > 3000000) throw new Error('Source exceeds 3 MB');
        chunks.push(p.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const body = Buffer.concat(chunks);
    entry.bytes = size;
    entry.sha256 = createHash('sha256').update(body).digest('hex');
    await fs.writeFile(path.join(root, file), body, { flag: 'wx' });
    entry.state = response.status === 200 ? 'downloaded' : 'unavailable';
    if (
      response.status === 403 ||
      /Access Denied|You don't have permission to access/i.test(
        body.toString('utf8'),
      )
    )
      entry.state = 'access_denied';
  } catch (e) {
    entry.state = 'failed';
    entry.error = e.message;
  }
  entry.finishedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(root, receiptFile),
    JSON.stringify(report, null, 2) + '\n',
  );
}
report.finishedAt = new Date().toISOString();
await fs.writeFile(
  path.join(root, receiptFile),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report, null, 2));
