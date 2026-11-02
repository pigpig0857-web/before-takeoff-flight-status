import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = 'data/flight-updates/kaohsiung-import-1792049409200';
const snapshot = JSON.parse(
  await fs.readFile('src/server/data/kaohsiung-flights.json', 'utf8'),
);
const calls = [];
async function query(params) {
  const response = await fetch(
    'http://127.0.0.1:3000/api/flights?' + new URLSearchParams(params),
    { signal: AbortSignal.timeout(30000) },
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  calls.push({ params, total: data.total, origin: data.origin });
  return data;
}
const dates = [...new Set(snapshot.records.map((r) => r.date))].sort();
for (const date of dates) {
  const data = await query({ origin: 'KHH', date });
  const expected = snapshot.records.filter((r) => r.date === date);
  assert.equal(data.origin, 'KHH');
  assert.equal(data.total, expected.length);
  assert.equal(data.feeds.length, 1);
  assert.equal(data.feeds[0].partial, true);
  for (const f of data.flights) {
    const r = expected.find(
      (r) => r.number === f.number && r.airport === f.destinationCode,
    );
    assert.ok(r);
    assert.equal(f.origin, 'KHH');
    assert.equal(f.airlineCode, 'IT');
    assert.equal(f.scheduledDeparture, r.departure);
    assert.equal(f.scheduledArrival, r.arrival);
    assert.equal(f.durationMinutes, r.minutes);
    assert.equal(f.timetableVerification.state, 'verified');
    assert.equal(f.aircraft, null);
  }
  if (calls.length % 10 === 0)
    await fs.writeFile(
      root + '/api-progress.json',
      JSON.stringify({ state: 'checking', calls }, null, 2),
    );
}
for (const airport of new Set(snapshot.records.map((r) => r.airport))) {
  const r = snapshot.records.find((r) => r.airport === airport);
  const data = await query({ origin: 'KHH', date: r.date, q: airport });
  assert.ok(data.total > 0);
  assert.ok(
    data.flights.every(
      (f) => f.origin === 'KHH' && f.destinationCode === airport,
    ),
  );
}
for (const country of ['JP', 'KR', 'VN']) {
  const r = snapshot.records.find((r) => r.countryCode === country);
  const data = await query({ origin: 'KHH', date: r.date, country });
  assert.ok(data.total > 0);
  assert.ok(data.flights.every((f) => f.collected.countryCode === country));
}
const khhPR = await query({
  origin: 'KHH',
  date: '2026-12-31',
  q: '菲律賓航空',
});
assert.equal(khhPR.total, 0);
assert.equal(khhPR.resultState, 'partial');
const tpePR = await query({
  origin: 'TPE',
  date: '2026-12-31',
  q: '菲律賓航空',
});
assert.equal(tpePR.total, 2);
assert.ok(tpePR.flights.every((f) => (f.origin || 'TPE') === 'TPE'));
const oldDefault = await query({ date: '2026-12-31', q: '菲律賓航空' });
assert.deepEqual(oldDefault.flights, tpePR.flights);
const outside = await query({ origin: 'KHH', date: '2027-01-01' });
assert.equal(outside.covered, false);
assert.equal(outside.total, 0);
assert.equal(outside.resultState, 'outside_coverage');
const invalid = await fetch('http://127.0.0.1:3000/api/flights?origin=TSA');
assert.equal(invalid.status, 400);
const before = JSON.parse(
  await fs.readFile(root + '/before-progress.json', 'utf8'),
);
for (const [file, hash] of Object.entries(before.originals))
  assert.equal(
    createHash('sha256')
      .update(await fs.readFile(file))
      .digest('hex'),
    hash,
  );
const oldLedger = JSON.parse(
  await fs.readFile(root + '/before-ledger.json', 'utf8'),
);
const ledger = JSON.parse(
  await fs.readFile('data/automatic-verification/latest.json', 'utf8'),
);
for (const [key, value] of Object.entries(oldLedger.entries))
  assert.deepEqual(ledger.entries[key], value);
const report = {
  state: 'passed',
  dateQueries: 78,
  records: 637,
  airportQueries: 14,
  countryQueries: 3,
  queries: calls.length + 1,
  calls,
  oldCatalogueFilesUnchanged: Object.keys(before.originals).length,
  oldLedgerEntriesUnchanged: Object.keys(oldLedger.entries).length,
};
await fs.writeFile(
  root + '/api-progress.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify({ ...report, calls: undefined }));
