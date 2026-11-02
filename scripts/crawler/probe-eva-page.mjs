/** One ordinary public GET; stop at redirects, never submit or bypass verification. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const directory = path.resolve('data/source-samples/crawler/eva-narita-trial');
const url =
  'https://booking.evaair.com/flyeva/eva/b2c/flight-schedules.aspx?lang=en-hk';
await fs.mkdir(directory, { recursive: true });
const report = {
  startedAt: new Date().toISOString(),
  sourceUrl: url,
  method: 'GET',
  requests: 1,
  flightQuerySubmitted: false,
};
try {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'FlightStatusResearch/0.1 (local schedule feasibility test)',
      Accept: 'text/html',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  const target = response.headers.get('location');
  const redirect = target ? new URL(target, url) : null;
  const chunks = [];
  let bytes = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.length;
        if (bytes > 2_000_000) throw new Error('HTML exceeds limit');
        chunks.push(result.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  const body = Buffer.concat(chunks),
    html = body.toString('utf8');
  Object.assign(report, {
    httpStatus: response.status,
    contentType: response.headers.get('content-type'),
    bytes,
    redirect: redirect
      ? { origin: redirect.origin, path: redirect.pathname }
      : null,
    sha256: createHash('sha256').update(body).digest('hex'),
    hasScheduleForm:
      html.includes('content_txt_formcity') &&
      html.includes('content_txt_tocity'),
    status: response.ok
      ? 'html_received_not_a_flight_search'
      : 'refused_or_redirected',
  });
  await fs.writeFile(path.join(directory, 'http-page.html'), body);
} catch (error) {
  Object.assign(report, { status: 'request_failed', error: error.message });
}
Object.assign(report, { finishedAt: new Date().toISOString() });
await fs.writeFile(
  path.join(directory, 'http-probe.json'),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
