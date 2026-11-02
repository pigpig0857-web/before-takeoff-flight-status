/** Verify the running website returns the audited multi-airline search results. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const cases = [
  { date: '2026-12-31', q: '日本東京', total: 7 },
  { date: '2026-12-31', q: 'NRT', total: 6 },
  { date: '2026-12-31', q: 'HND', total: 1 },
  { date: '2026-12-31', q: '樂桃', total: 11 },
  { date: '2026-12-31', q: 'MM024', total: 1 },
  { date: '2026-12-31', q: '日本東京', start: '12:00', total: 3 },
  { date: '2026-10-27', q: 'MM', total: 13 },
  { date: '2027-01-01', q: '日本東京', total: 0 },
];
const results = [];
for (const c of cases) {
  const params = new URLSearchParams({
    date: c.date,
    q: c.q,
    start: c.start || '00:00',
  });
  const response = await fetch(`http://127.0.0.1:3000/api/flights?${params}`, {
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.mode, 'official');
  assert.equal(data.total, c.total, `${c.date} ${c.q}`);
  assert.ok(data.flights.every((f) => ['BR', 'MM'].includes(f.airlineCode)));
  assert.ok(
    !data.feeds.some((f) =>
      ['collected_ci', 'collected_trip'].includes(f.kind),
    ),
  );
  if (c.q === 'HND') {
    assert.equal(data.flights[0].scheduledArrival, '2027-01-01T00:50:00+09:00');
    assert.equal(data.flights[0].collected.sourcePublishedAt, '2026-09-16');
  }
  results.push({
    ...c,
    actual: data.total,
    carriers: [...new Set(data.flights.map((f) => f.airlineCode))],
    resultState: data.resultState,
  });
}
await fs.writeFile(
  'data/cache/peach-yearend/website-smoke.json',
  JSON.stringify(
    { checkedAt: new Date().toISOString(), status: 'passed', results },
    null,
    2,
  ),
);
console.log(JSON.stringify(results, null, 2));
