/** Verify every saved EVA detail and build an explicit Peach date/route work queue. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei',
}).format(new Date());
const until = '2026-12-31';
const root = path.resolve(
  'data/source-samples/crawler/yearend-completeness-20261012',
);
await fs.mkdir(root, { recursive: true });
const eva = JSON.parse(
  await fs.readFile('src/server/data/eva-flights.json', 'utf8'),
);
const peach = JSON.parse(
  await fs.readFile('src/server/data/peach-flights.json', 'utf8'),
);
const booking = JSON.parse(
  await fs.readFile('src/server/data/peach-booking-checks.json', 'utf8'),
);
const evidenceRoot = path.resolve(
  'data/source-samples/crawler/eva-yearend-2026',
);
const manifest = JSON.parse(
  await fs.readFile(
    path.join(evidenceRoot, 'full-details/manifest.json'),
    'utf8',
  ),
);
const key = (r) => `${r.date}|${r.number}|${r.airport}`;
const lookup = new Map(manifest.map((entry) => [key(entry), entry]));
const errors = [];
let verified = 0,
  missingArrivalTerminal = 0;
const records = eva.records.filter((r) => r.date >= today && r.date <= until);
for (const record of records) {
  const entry = lookup.get(key(record));
  try {
    if (!entry || entry.status !== 'verified')
      throw new Error('Missing verified manifest entry');
    const file = path.resolve(evidenceRoot, entry.evidenceFile);
    if (!file.startsWith(evidenceRoot + path.sep))
      throw new Error('Evidence path outside workspace source directory');
    const html = await fs.readFile(file);
    if (createHash('sha256').update(html).digest('hex') !== entry.sha256)
      throw new Error('Evidence hash mismatch');
    const d = entry.evidence;
    if (
      !record.detail ||
      d.url !== record.detail.url ||
      d.fetchedAt !== record.detail.fetchedAt ||
      d.departureTerminal !== record.terminal ||
      d.arrivalTerminal !== record.arrivalTerminal ||
      d.aircraft !== record.aircraft ||
      d.minutes !== record.minutes ||
      !d.nonstop ||
      d.scope !== 'segment'
    )
      throw new Error('Snapshot/detail mismatch');
    verified++;
    if (!record.arrivalTerminal) missingArrivalTerminal++;
  } catch (e) {
    errors.push({ identity: key(record), error: e.message });
  }
}
const queries = new Map();
for (const record of peach.records.filter(
  (r) => r.date >= today && r.date <= until,
)) {
  const qkey = `${record.date}|${record.airport}`;
  const query = queries.get(qkey) || {
    date: record.date,
    airport: record.airport,
    flights: [],
  };
  const check = booking.records.find(
    (c) =>
      key(c) === key(record) &&
      c.departure === record.departure &&
      c.arrival === record.arrival,
  );
  query.flights.push({
    number: record.number,
    departure: record.departure,
    arrival: record.arrival,
    minutes: record.minutes,
    state: check ? 'verified_booking_result' : 'not_queried',
    aircraft: check?.aircraft || null,
  });
  queries.set(qkey, query);
}
const queue = [...queries.values()].sort(
  (a, b) => a.airport.localeCompare(b.airport) || a.date.localeCompare(b.date),
);
const report = {
  checkedAt: new Date().toISOString(),
  from: today,
  until,
  eva: {
    records: records.length,
    evidenceHashVerified: verified,
    sourceDidNotProvideArrivalTerminal: missingArrivalTerminal,
    errors,
  },
  peach: {
    records: queue.reduce((n, q) => n + q.flights.length, 0),
    queries: queue.length,
    verified: queue
      .flatMap((q) => q.flights)
      .filter((f) => f.state === 'verified_booking_result').length,
    notQueried: queue
      .flatMap((q) => q.flights)
      .filter((f) => f.state === 'not_queried').length,
    dateSpecificTerminalAvailable: 0,
  },
  liveChangesRechecked: false,
  allActualFlightsGuaranteed: false,
};
await fs.writeFile(
  path.join(root, 'evidence-audit.json'),
  JSON.stringify(report, null, 2),
);
await fs.writeFile(
  path.join(root, 'peach-query-queue.json'),
  JSON.stringify(queue, null, 2),
);
console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;
