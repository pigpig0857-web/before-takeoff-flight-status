import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const run = 'data/flight-updates/integrate-jta-jetstar-20261014';
const rows = (await Promise.all(['jta', 'jetstar'].map(async brand => JSON.parse(await fs.readFile(`src/server/data/${brand}-flights.json`, 'utf8')).records))).flat();
const dates = [...new Set(rows.map(r => r.date))].sort();
const progress = { state: 'running', startedAt: new Date().toISOString(), dates: [], rows: 0, searches: [] };
async function query(params) {
  const response = await fetch(`http://127.0.0.1:3000/api/flights?${new URLSearchParams({ start: '00:00', ...params })}`, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200);
  return response.json();
}
const save = () => fs.writeFile(`${run}/api-check.json`, JSON.stringify(progress, null, 2));
try {
  for (const date of dates) {
    const data = await query({ date });
    const expected = rows.filter(r => r.date === date);
    const actual = data.flights.filter(f => ['NU', 'GK'].includes(f.airlineCode));
    assert.equal(actual.length, expected.length, date);
    for (const r of expected) {
      const f = actual.find(f => f.number === r.number && f.destinationCode === r.airport);
      assert.ok(f, `${date} ${r.number}`);
      // Airport realtime updates are authoritative for today's flight.
      if (f.source !== 'realtime') {
        assert.equal(f.scheduledDeparture, r.departure);
        assert.equal(f.scheduledArrival, r.arrival);
        assert.equal(f.durationMinutes, r.minutes);
        assert.equal(f.terminal, r.terminal);
        assert.equal(f.aircraft, r.aircraft);
        assert.equal(f.collected.label, r.label);
        assert.equal(f.collected.terminalReference.basis, r.terminalReference.basis);
      }
      assert.equal(f.arrivalTimeZone, r.arrivalTimeZone);
    }
    progress.dates.push({ date, expected: expected.length, actual: actual.length });
    progress.rows += actual.length;
    await save();
  }
  for (const [q, date, total] of [
    ['日本越洋航空', '2026-12-31', 2], ['捷星日本航空', '2026-12-31', 5],
    ['GK50', '2026-11-10', 1], ['NU308', '2026-10-23', 0],
    ['GK16', '2026-12-29', 1], ['GK16', '2026-12-30', 0],
    ['GK', '2027-01-01', 0], ['NU', '2027-01-01', 0],
  ]) {
    const data = await query({ q, date });
    assert.equal(data.total, total, `${q} ${date}`);
    progress.searches.push({ q, date, total });
    await save();
  }
  const japan = await query({ country: 'JP', date: '2026-12-31' });
  assert.equal(japan.flights.filter(f => ['NU', 'GK'].includes(f.airlineCode)).length, 7);
  assert.ok(japan.flights.some(f => f.airlineCode === 'BR'));
  const before = JSON.parse(await fs.readFile(`${run}/progress.json`, 'utf8')).beforeHashes;
  for (const [name, expected] of Object.entries(before))
    assert.equal(createHash('sha256').update(await fs.readFile(`src/server/data/${name}`)).digest('hex'), expected, name);
  progress.originalFilesUnchanged = Object.keys(before).length;
  progress.state = 'passed';
  progress.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ state: progress.state, dates: dates.length, rows: progress.rows, searches: progress.searches.length, originalFilesUnchanged: progress.originalFilesUnchanged }));
} catch (error) {
  progress.state = 'failed';
  progress.error = String(error);
  await save();
  throw error;
}
