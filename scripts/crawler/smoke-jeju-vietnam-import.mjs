import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const run = 'data/flight-updates/integrate-jeju-vietnam-2026-10-14T02-46-45.340Z';
const sources = (await Promise.all(['jeju', 'vietnam'].map(async name => JSON.parse(await fs.readFile(`src/server/data/${name}-flights.json`, 'utf8')).records))).flat();
const dates = [...new Set(sources.filter(f => f.date >= '2026-10-14').map(f => f.date))].sort();
const progress = { checkedAt: new Date().toISOString(), state: 'running', dates: [], rows: 0 };
async function query(params) {
  const response = await fetch(`http://127.0.0.1:3000/api/flights?${new URLSearchParams({ start: '00:00', ...params })}`, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200);
  return response.json();
}
for (const date of dates) {
  const data = await query({ date });
  const expected = sources.filter(f => f.date === date);
  // Today's primary airport feed legitimately adds codeshare numbers and live metadata.
  const actual = data.flights.filter(f => expected.some(e => e.number === f.number && e.airport === f.destinationCode));
  assert.equal(actual.length, expected.length, date);
  assert.ok(data.flights.filter(f => ['collected_jeju', 'collected_vietnam'].includes(f.source)).every(f => expected.some(e => e.number === f.number && e.airport === f.destinationCode)));
  for (const saved of expected) {
    const flight = actual.find(f => f.number === saved.number && f.destinationCode === saved.airport);
    assert.ok(flight, `${date} ${saved.number}`);
    assert.equal(Date.parse(flight.scheduledDeparture), Date.parse(saved.departure));
    assert.equal(Date.parse(flight.scheduledArrival), Date.parse(saved.arrival));
    assert.equal(flight.arrivalTimeZone, saved.arrivalTimeZone);
    assert.equal(flight.durationMinutes, saved.minutes);
    if (flight.source !== 'realtime') {
      assert.equal(flight.aircraft, saved.aircraft);
      assert.equal(flight.terminal, saved.terminal);
      assert.equal(flight.gate, null);
      assert.equal(flight.counter, null);
    }
    assert.equal(flight.arrivalTerminal, saved.arrivalTerminal);
    assert.equal(flight.collected.fetchedAt, saved.fetchedAt);
    assert.equal(flight.collected.codeshare, false);
  }
  progress.dates.push({ date, expected: expected.length, actual: actual.length });
  progress.rows += actual.length;
  await fs.writeFile(`${run}/api-check.json`, JSON.stringify(progress, null, 2));
}
const cases = [
  { date: '2026-12-31', q: '濟州航空', total: 3, code: '7C' },
  { date: '2026-12-31', q: '越南航空', total: 3, code: 'VN' },
  { date: '2026-12-31', q: '7C06102', total: 1, code: '7C' },
  { date: '2026-12-28', q: 'VN571', start: '07:45', total: 1, code: 'VN' },
  { date: '2026-12-28', q: 'VN571', start: '07:46', total: 0 },
  { date: '2027-01-01', q: '濟州航空', total: 0 },
  { date: '2027-01-01', q: '越南航空', total: 0 },
];
progress.searches = [];
for (const { total, code, ...params } of cases) {
  const data = await query(params);
  assert.equal(data.total, total, JSON.stringify(params));
  if (code) assert.ok(data.flights.every(f => f.airlineCode === code));
  progress.searches.push({ ...params, total: data.total });
}
for (const [country, code] of [['KR', '7C'], ['VN', 'VN']]) {
  const data = await query({ date: '2026-12-31', country });
  assert.equal(data.flights.filter(f => f.airlineCode === code).length, 3);
  assert.ok(data.flights.some(f => f.airlineCode === 'BR'));
}
const imports = JSON.parse(await fs.readFile(`${run}/progress.json`, 'utf8'));
for (const [file, expected] of Object.entries(imports.beforeHashes)) {
  const hash = crypto.createHash('sha256').update(await fs.readFile(`src/server/data/${file}`)).digest('hex');
  assert.equal(hash, expected, file);
}
progress.originalFilesUnchanged = Object.keys(imports.beforeHashes).length;
progress.state = 'passed';
progress.finishedAt = new Date().toISOString();
await fs.writeFile(`${run}/api-check.json`, JSON.stringify(progress, null, 2));
console.log(JSON.stringify({ state: progress.state, dates: dates.length, rows: progress.rows, searches: progress.searches.length, originalFilesUnchanged: progress.originalFilesUnchanged }));
