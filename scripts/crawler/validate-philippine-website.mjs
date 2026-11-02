// Read-only requests to this project's local API; no direct airline requests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = 'data/flight-updates/philippine-import-1792046646822';
const before = JSON.parse(
  await fs.readFile(root + '/before-progress.json', 'utf8'),
);
const digest = (b) => createHash('sha256').update(b).digest('hex');
const snapshot = JSON.parse(
  await fs.readFile('src/server/data/philippine-flights.json', 'utf8'),
);
const checks = [];
for (const date of [...new Set(snapshot.records.map((r) => r.date))]) {
  const response = await fetch(
    'http://127.0.0.1:3000/api/flights?' +
      new URLSearchParams({
        date,
        q: '菲律賓航空',
        start: '00:00',
        end: '23:59',
      }),
    { signal: AbortSignal.timeout(30000) },
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.mode, 'official');
  const expected = snapshot.records.filter((r) => r.date === date);
  assert.ok(result.total >= expected.length, date);
  const extra = result.flights.filter(
    (f) => !expected.some((r) => r.number === f.number),
  );
  assert.ok(
    extra.every(
      (f) => ['realtime', 'schedule'].includes(f.source) && !f.collected,
    ),
    'Extra rows must retain independent airport-source attribution',
  );
  for (const row of expected) {
    const flight = result.flights.find((f) => f.number === row.number);
    assert.ok(flight, `${date} ${row.number}`);
    assert.equal(flight.airlineCode, 'PR');
    assert.equal(flight.destinationCode, 'MNL');
    assert.equal(flight.scheduledDeparture, row.departure);
    assert.equal(flight.scheduledArrival, row.arrival);
    assert.equal(flight.durationMinutes, row.minutes);
    assert.equal(flight.collected.url, row.url);
    if (flight.source === 'collected_philippine')
      assert.equal(flight.timetableVerification.state, 'verified');
    assert.equal(flight.collected.codeshare, null);
    if (flight.source === 'collected_philippine')
      assert.equal(flight.aircraft, null);
  }
  checks.push({
    date,
    records: expected.length,
    totalIncludingAirportData: result.total,
    extraAirportRows: extra.map((f) => f.number),
    numbers: expected.map((f) => f.number),
  });
  if (checks.length % 10 === 0)
    await fs.writeFile(
      root + '/api-progress.json',
      JSON.stringify(
        { state: 'checking', checked: checks.length, checks },
        null,
        2,
      ),
    );
}
const oldLedger = JSON.parse(
  await fs.readFile(root + '/before-ledger.json', 'utf8'),
);
const ledger = JSON.parse(
  await fs.readFile('data/automatic-verification/latest.json', 'utf8'),
);
for (const [key, value] of Object.entries(oldLedger.entries))
  assert.deepEqual(ledger.entries[key], value);
for (const [file, hash] of Object.entries(before.originals))
  assert.equal(digest(await fs.readFile(file)), hash);
const report = {
  state: 'passed',
  dateQueries: checks.length,
  records: checks.reduce((s, r) => s + r.records, 0),
  checks,
  oldCatalogueFilesUnchanged: Object.keys(before.originals).length,
  oldLedgerEntriesUnchanged: Object.keys(oldLedger.entries).length,
  port: 3000,
};
await fs.writeFile(
  root + '/api-progress.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify({ ...report, checks: undefined }));
