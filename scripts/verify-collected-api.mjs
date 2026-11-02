import assert from 'node:assert/strict';
const base = process.argv[2] || 'http://127.0.0.1:3000';
async function query(date, q = '', start = '00:00') {
  const response = await fetch(
    `${base}/api/flights?${new URLSearchParams({ date, q, start })}`,
    { signal: AbortSignal.timeout(30000) },
  );
  assert.equal(response.status, 200);
  return response.json();
}
const tokyo = await query('2026-12-30', '日本東京');
assert.equal(tokyo.total, 29);
assert.equal(tokyo.resultState, 'matches');
assert.ok(
  tokyo.flights.every(
    (f) => f.destinationCode === 'NRT' && f.scheduledArrival && f.collected,
  ),
);
const after = await query('2026-12-30', '日本東京', '12:00');
assert.ok(after.total > 0 && after.total < 29);
assert.ok(
  after.flights.every((f) => f.scheduledDeparture.slice(11, 16) >= '12:00'),
);
const sydney = await query('2027-01-15', 'CI51');
assert.equal(sydney.total, 1);
assert.equal(sydney.flights[0].scheduledArrival, '2027-01-16T12:15:00+11:00');
const sfo = await query('2027-01-15', 'JX012');
assert.equal(sfo.flights[0].scheduledArrival, '2027-01-14T19:10:00-08:00');
const missing = await query('2026-12-30', '巴黎');
assert.equal(missing.total, 0);
assert.equal(missing.resultState, 'partial');
const gap = await query('2026-12-31', '日本東京');
assert.equal(gap.covered, false);
assert.equal(gap.resultState, 'outside_coverage');
console.log(
  JSON.stringify(
    {
      tokyo: tokyo.total,
      tokyoAfterNoon: after.total,
      sydneyArrival: sydney.flights[0].scheduledArrival,
      sanFranciscoArrival: sfo.flights[0].scheduledArrival,
      missingDestination: missing.resultState,
      uncollectedDate: gap.resultState,
    },
    null,
    2,
  ),
);
