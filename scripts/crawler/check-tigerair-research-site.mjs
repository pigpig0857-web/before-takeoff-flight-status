// Read-only smoke check: this phase must not enable the new airline in the UI.
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:3000';
const checks = [];
for (const endpoint of ['/', '/api/health', '/api/flights?date=2026-12-31']) {
  const response = await fetch(`${base}${endpoint}`, {
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, 200, endpoint);
  const check = { endpoint, status: response.status };
  if (endpoint.startsWith('/api/flights')) {
    const json = await response.json();
    assert.ok(json.flights.length > 0);
    const airlines = [
      ...new Set(json.flights.map((f) => f.airlineCode)),
    ].sort();
    assert.deepEqual(airlines, ['BR', 'MM']);
    check.airlines = airlines;
    check.flights = json.flights.length;
  } else await response.arrayBuffer();
  checks.push(check);
}
const result = {
  checkedAt: new Date().toISOString(),
  state: 'passed',
  checks,
  newAirlinePublished: false,
};
await writeFile(
  'data/source-samples/crawler/tigerair-research-20261013/website-smoke.json',
  JSON.stringify(result, null, 2),
  { flag: 'wx' },
);
console.log(JSON.stringify(result));
