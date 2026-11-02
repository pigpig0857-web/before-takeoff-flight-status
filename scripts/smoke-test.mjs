import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const airportDirectory = JSON.parse(
  await fs.readFile(
    new URL(
      '../src/features/flights/data/airport-directory.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const countryByAirport = new Map(
  airportDirectory.map((a) => [a.code, a.countryCode]),
);
const base = process.argv[2] || 'http://127.0.0.1:3000';
async function request(path) {
  return fetch(`${base}${path}`, { signal: AbortSignal.timeout(20000) });
}
const page = await request('/');
assert.equal(page.status, 200);
assert.match(await page.text(), /起飛之前/);
assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
assert.equal((await request('/api/health')).status, 200);
const flights = await (await request('/api/flights')).json();
assert.ok(['official', 'demo'].includes(flights.mode));
assert.ok(Array.isArray(flights.feeds));
assert.equal(flights.total, flights.flights.length);
if (flights.covered) {
  assert.ok(flights.total > 0);
  const flight = flights.flights[0];
  const match = await (
    await request(
      `/api/flights?${new URLSearchParams({ date: flight.date, q: flight.number })}`,
    )
  ).json();
  assert.ok(match.flights.some((f) => f.id === flight.id));
  const none = await (
    await request(`/api/flights?date=${flights.today}&q=NOT_A_REAL_FLIGHT`)
  ).json();
  assert.equal(none.total, 0);
  assert.equal(none.covered, true);
  const todayFeeds = flights.feeds.filter(feed => feed.dates.includes(flights.today));
  assert.equal(none.resultState, todayFeeds.length && todayFeeds.every(feed => feed.partial) ? 'partial' : 'no_matches');
  const tokyo = await (
    await request(
      `/api/flights?${new URLSearchParams({ date: flights.today, q: '我要去日本東京', start: '10:00' })}`,
    )
  ).json();
  const expected = flights.flights.filter(
    (f) =>
      ['NRT', 'HND'].includes(f.destinationCode) &&
      f.scheduledDeparture.slice(11, 16) >= '10:00',
  );
  assert.deepEqual(
    tokyo.flights.map((f) => f.id),
    expected.map((f) => f.id),
  );
  const narita = await (
    await request(
      `/api/flights?${new URLSearchParams({ date: flights.today, q: '成田', start: '10:00' })}`,
    )
  ).json();
  assert.deepEqual(
    narita.flights.map((f) => f.id),
    expected.filter((f) => f.destinationCode === 'NRT').map((f) => f.id),
  );
  for (const [q, country] of [
    ['韓國', 'KR'],
    ['中國', 'CN'],
    ['日本', 'JP'],
    ['泰國', 'TH'],
    ['美國', 'US'],
  ]) {
    const result = await (
      await request(
        `/api/flights?${new URLSearchParams({ date: flights.today, q, start: '10:00' })}`,
      )
    ).json();
    const expected = flights.flights.filter(
      (f) =>
        (countryByAirport.get(f.destinationCode) ||
          f.collected?.countryCode) === country &&
        f.scheduledDeparture.slice(11, 16) >= '10:00',
    );
    assert.deepEqual(
      result.flights.map((f) => f.id),
      expected.map((f) => f.id),
      q,
    );
  }
}
const outside = new Date(`${flights.today}T12:00:00Z`);
outside.setUTCFullYear(outside.getUTCFullYear() + 10);
const unavailable = await (
  await request(`/api/flights?date=${outside.toISOString().slice(0, 10)}`)
).json();
assert.equal(unavailable.covered, false);
assert.equal(unavailable.total, 0);
assert.equal(unavailable.resultState, 'outside_coverage');
for (const query of [
  'date=2026-02-30',
  'start=18:00&end=06:00',
  'status=invalid',
])
  assert.equal((await request(`/api/flights?${query}`)).status, 400);
assert.equal(
  (await fetch(`${base}/api/flights`, { method: 'POST' })).status,
  405,
);
assert.equal((await request('/missing')).status, 404);
console.log(
  `PASS: page, security header, liveness, ${flights.mode} search, missing coverage, invalid filters, 404/405. Available: ${flights.dates.join(', ') || 'none'}`,
);
