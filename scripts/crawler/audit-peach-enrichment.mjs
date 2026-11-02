import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
const outputRoot = path.resolve(
  process.argv[2] ||
    'data/source-samples/crawler/peach-detail-enrichment-20261012',
);
assert.equal(
  path.dirname(outputRoot),
  path.resolve('data/source-samples/crawler'),
);
const snapshot = JSON.parse(
  await fs.readFile('src/server/data/peach-flights.json', 'utf8'),
);
const evidence = JSON.parse(
  await fs.readFile('src/server/data/peach-booking-checks.json', 'utf8'),
);
const canonical = (number) => number.replace(/^MM0+(?=\d)/, 'MM');
const dates = [
  ...new Set(snapshot.records.map((record) => record.date)),
].sort();
let total = 0,
  guided = 0,
  checked = 0;
const results = [];
for (const date of dates) {
  const response = await fetch(
    `http://127.0.0.1:3000/api/flights?date=${date}&q=MM&start=00:00`,
    { signal: AbortSignal.timeout(30000) },
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  const expected = snapshot.records.filter((record) => record.date === date);
  assert.equal(data.total, expected.length, date);
  for (const saved of expected) {
    const flight = data.flights.find(
      (f) =>
        canonical(f.number) === canonical(saved.number) &&
        f.destinationCode === saved.airport,
    );
    assert.ok(flight, `${date}:${saved.number}`);
    assert.equal(flight.airportGuidance?.scope, 'airline_airport_guide');
    assert.equal(flight.airportGuidance.departure.airport, 'TPE');
    assert.equal(flight.airportGuidance.arrival.airport, saved.airport);
    assert.equal(flight.scheduledDeparture, saved.departure);
    assert.equal(flight.scheduledArrival, saved.arrival);
    const check = evidence.records.find(
      (c) =>
        c.date === date &&
        c.number === saved.number &&
        c.airport === saved.airport,
    );
    assert.equal(flight.bookingCheck?.aircraft, check?.aircraft);
    if (flight.source === 'collected_peach') {
      assert.equal(flight.terminal, null);
      assert.equal(flight.arrivalTerminal, null);
      assert.equal(flight.aircraft, null);
    }
    total++;
    guided++;
    if (flight.bookingCheck) checked++;
  }
  results.push({ date, flights: data.total });
}
const mixed = await (
  await fetch(
    'http://127.0.0.1:3000/api/flights?date=2026-12-31&q=%E6%9D%B1%E4%BA%AC&start=00:00',
  )
).json();
assert.equal(mixed.flights.filter((f) => f.airlineCode === 'BR').length, 3);
assert.ok(
  mixed.flights
    .filter((f) => f.airlineCode === 'BR')
    .every((f) => !f.airportGuidance && !f.bookingCheck),
);
assert.equal(total, 885);
assert.equal(checked, evidence.records.length);
const audit = {
  checkedAt: new Date().toISOString(),
  dates: dates.length,
  total,
  guided,
  checked,
  aircraftNotYetChecked: total - checked,
  discrepancies: 0,
  evaUnaffected: true,
  results,
};
await fs.writeFile(
  path.join(outputRoot, 'website-enrichment-audit.json'),
  JSON.stringify(audit, null, 2),
);
console.log(JSON.stringify({ ...audit, results: undefined }, null, 2));
