/** Compare actual local website responses with the audited EVA snapshot. */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const snapshot = JSON.parse(
  await fs.readFile('src/server/data/eva-flights.json', 'utf8'),
);
const cases = [
  { date: '2026-12-31', q: '日本東京', airport: 'NRT', start: '00:00' },
  { date: '2026-12-31', q: '韓國首爾', airport: 'ICN', start: '00:00' },
  { date: '2026-12-31', q: '美國舊金山', airport: 'SFO', start: '00:00' },
  { date: '2026-12-30', q: '印度新德里', airport: 'DEL', start: '00:00' },
  { date: '2026-12-31', q: '日本東京', airport: 'NRT', start: '12:00' },
];
const root = await fetch('http://127.0.0.1:3000/', {
  signal: AbortSignal.timeout(20000),
});
assert.equal(root.status, 200);
await root.body?.cancel();
const results = [];
for (const c of cases) {
  const response = await fetch(
    `http://127.0.0.1:3000/api/flights?${new URLSearchParams({ date: c.date, q: c.q, start: c.start })}`,
    { signal: AbortSignal.timeout(60000) },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, 'official');
  const actual = body.flights.filter((f) => f.source === 'collected_eva');
  const expected = snapshot.records.filter(
    (r) =>
      r.date === c.date &&
      r.airport === c.airport &&
      r.departure.slice(11, 16) >= c.start,
  );
  assert.ok(expected.length);
  assert.equal(actual.length, expected.length);
  for (const r of expected) {
    const f = actual.find(
      (f) => f.number === r.number && f.destinationCode === r.airport,
    );
    assert.ok(f);
    assert.equal(f.scheduledDeparture, r.departure);
    assert.equal(f.scheduledArrival, r.arrival);
    assert.equal(f.durationMinutes, r.minutes);
  }
  assert.ok(
    body.feeds.some(
      (f) => f.kind === 'collected_eva' && f.dates.includes(c.date),
    ),
  );
  const result = {
    ...c,
    httpStatus: response.status,
    verifiedEvaFlights: actual.length,
    resultState: body.resultState,
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
await fs.writeFile(
  'data/source-samples/crawler/eva-yearend-2026/website-check.json',
  JSON.stringify(
    { checkedAt: new Date().toISOString(), rootStatus: 200, cases: results },
    null,
    2,
  ),
);
