/** Audit every Peach date through the public localhost API without modifying snapshots. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const evidenceDirectory = path.resolve(process.argv[2] || '');
assert.equal(
  path.dirname(evidenceDirectory),
  path.resolve('data/source-samples/crawler'),
);
const snapshot = JSON.parse(
  await fs.readFile('src/server/data/peach-flights.json', 'utf8'),
);
const dates = [...new Set(snapshot.records.map((r) => r.date))].sort();
const number = (value) => value.replace(/^MM0+(?=\d)/, 'MM');
const key = (r) =>
  `${r.date}:${number(r.number)}:${r.destinationCode || r.airport}`;
const checks = [],
  discrepancies = [],
  primaryOverrides = [],
  extraPrimaryFlights = [];
let matched = 0;
for (const [index, date] of dates.entries()) {
  const expected = snapshot.records.filter((r) => r.date === date);
  const response = await fetch(
    `http://127.0.0.1:3000/api/flights?${new URLSearchParams({ date, q: 'MM', start: '00:00' })}`,
    { signal: AbortSignal.timeout(30000) },
  );
  assert.equal(response.status, 200, date);
  const data = await response.json();
  assert.equal(data.mode, 'official');
  assert.equal(data.total, data.flights.length);
  assert.ok(data.flights.every((f) => f.airlineCode === 'MM'));
  const actual = new Map(data.flights.map((f) => [key(f), f]));
  if (actual.size !== data.flights.length)
    discrepancies.push({ date, problem: 'duplicate_website_identity' });
  const expectedKeys = new Set(expected.map(key));
  const dateDiscrepancies = [];
  for (const r of expected) {
    const f = actual.get(key(r));
    if (!f) {
      dateDiscrepancies.push({ identity: key(r), problem: 'missing' });
      continue;
    }
    if (f.source !== 'collected_peach') {
      if (!['realtime', 'schedule'].includes(f.source))
        dateDiscrepancies.push({
          identity: key(r),
          problem: 'unexpected_source',
          source: f.source,
        });
      else
        primaryOverrides.push({
          identity: key(r),
          source: f.source,
          savedDeparture: r.departure,
          currentDeparture: f.scheduledDeparture,
        });
      continue;
    }
    for (const [published, saved] of [
      ['scheduledDeparture', 'departure'],
      ['scheduledArrival', 'arrival'],
      ['arrivalTimeZone', 'arrivalTimeZone'],
      ['durationMinutes', 'minutes'],
      ['terminal', 'terminal'],
      ['arrivalTerminal', 'arrivalTerminal'],
      ['aircraft', 'aircraft'],
    ]) {
      if (f[published] !== r[saved])
        dateDiscrepancies.push({
          identity: key(r),
          field: published,
          expected: r[saved],
          actual: f[published],
        });
    }
    for (const field of ['url', 'fetchedAt', 'sourcePublishedAt']) {
      if (f.collected?.[field] !== r[field])
        dateDiscrepancies.push({
          identity: key(r),
          field,
          expected: r[field],
          actual: f.collected?.[field],
        });
    }
    matched++;
  }
  for (const f of data.flights.filter((f) => !expectedKeys.has(key(f)))) {
    if (f.source === 'collected_peach')
      dateDiscrepancies.push({
        identity: key(f),
        problem: 'unexpected_collected_flight',
      });
    else extraPrimaryFlights.push({ identity: key(f), source: f.source });
  }
  discrepancies.push(...dateDiscrepancies);
  checks.push({
    date,
    expected: expected.length,
    website: data.total,
    discrepancies: dateDiscrepancies.length,
  });
  if ((index + 1) % 20 === 0 || index === dates.length - 1)
    console.log(
      JSON.stringify({
        checkedDates: index + 1,
        dates: dates.length,
        discrepancies: discrepancies.length,
      }),
    );
}
const report = {
  checkedAt: new Date().toISOString(),
  status: discrepancies.length ? 'failed' : 'passed',
  dates: dates.length,
  expectedRecords: snapshot.records.length,
  matchingCollectedRecords: matched,
  discrepancies,
  primaryOverrides,
  extraPrimaryFlights,
  checks,
  websiteSnapshotsModified: false,
};
await fs.writeFile(
  path.join(evidenceDirectory, 'website-audit.json'),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify({ ...report, checks: undefined }));
assert.equal(
  discrepancies.length,
  0,
  'Website differs from imported Peach snapshot',
);
