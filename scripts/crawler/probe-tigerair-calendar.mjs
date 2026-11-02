// The query and endpoint are published in Tigerair's flight-schedule client.
// Anonymous reads only; evidence is saved once and never silently overwritten.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve(
  'data/source-samples/crawler/tigerair-research-20261013',
);
const since = process.argv[2] || '2026-10-24';
const until = process.argv[3] || '2026-10-25';
if (!/^2026-\d{2}-\d{2}$/.test(since) || !/^2026-\d{2}-\d{2}$/.test(until))
  throw new Error('Explicit 2026 research dates required');
const prefix = `calendar-${since}-${until}`;
await mkdir(root, { recursive: true });
const query = `query flightScheduleCalendar($origin: String!, $destinations: [String!]!, $since: Date!, $until: Date!) {
  calendarFlightSchedules(origin: $origin destinations: $destinations since: $since until: $until) {
    date
    flights { origin destination carrierCode flightNumber departureTime arrivalTime overnight }
  }
}`;
const raw = JSON.parse(
  await readFile(path.join(root, 'merged-schedules.json'), 'utf8'),
);
const destinations = [
  ...new Set(
    raw.data
      .flatMap((c) => c.stationSchedules.flatMap((st) => st.schedules))
      .filter((s) => s.origin === 'TPE')
      .map((s) => s.destination),
  ),
].sort();
const request = {
  query,
  variables: { origin: 'TPE', destinations, since, until },
};
const file = (name) => path.join(root, `${prefix}-${name}.json`);
// Exclusive creation ensures a completed or interrupted request is not repeated.
await writeFile(file('request'), JSON.stringify(request, null, 2), {
  flag: 'wx',
});
const url = 'https://api-cms.tigerairtw.com/graphql';
const startedAt = new Date().toISOString();
try {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-language': 'zh-TW' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(60000),
    redirect: 'error',
  });
  const body = Buffer.from(await response.arrayBuffer());
  await writeFile(file('response'), body, { flag: 'wx' });
  const receipt = {
    url,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: response.status,
    authenticated: false,
    bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
  await writeFile(file('receipt'), JSON.stringify(receipt, null, 2), {
    flag: 'wx',
  });
  if (!response.ok)
    throw new Error(
      `HTTP ${response.status}; response preserved, do not retry`,
    );
  const json = JSON.parse(body.toString('utf8'));
  if (!response.ok || json.errors)
    throw new Error(JSON.stringify(json.errors || { status: response.status }));
  const calendar = json.data?.calendarFlightSchedules;
  if (!Array.isArray(calendar)) throw new Error('Unexpected calendar schema');
  console.log(
    JSON.stringify({
      ...receipt,
      days: calendar.length,
      flights: calendar.reduce((n, d) => n + d.flights.length, 0),
      sample: calendar[0],
    }),
  );
} catch (error) {
  await writeFile(
    file('error'),
    JSON.stringify(
      {
        startedAt,
        failedAt: new Date().toISOString(),
        message: error.message,
        pending: true,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  throw error;
}
