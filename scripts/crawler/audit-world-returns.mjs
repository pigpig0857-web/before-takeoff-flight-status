// Independent JS source replay + Intl timezone audit of Python-normalized data.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root = 'data/source-samples/crawler/return-world-20261019';
const read = async (p) =>
  JSON.parse((await fs.readFile(p, 'utf8')).replace(/^\uFEFF/, ''));
const sha = async (p) =>
  createHash('sha256')
    .update(await fs.readFile(p))
    .digest('hex');
const id = (r) =>
  [r.date, r.airlineCode, r.number, r.departureAirport, r.arrivalAirport].join(
    '|',
  );
function parts(instant, zone) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const v = Object.fromEntries(p.map((p) => [p.type, p.value]));
  return {
    date: `${v.year}-${v.month}-${v.day}`,
    time: `${v.hour}:${v.minute}`,
  };
}
const reports = [];
for (const folder of ['JX', '7C', 'VN', 'PR-latest', 'GK-latest', 'NU']) {
  const base = root + '/verified/' + folder;
  const rows = (await read(base + '/candidate-flights.json')).records;
  assert.equal(new Set(rows.map(id)).size, rows.length);
  const cache = new Map();
  for (const r of rows) {
    for (const name of [
      'date',
      'number',
      'airlineCode',
      'airline',
      'departureAirport',
      'arrivalAirport',
      'departure',
      'arrival',
      'departureTimeZone',
      'arrivalTimeZone',
      'url',
      'fetchedAt',
      'sourceSha256',
    ])
      assert.ok(r[name]);
    assert.ok(r.date >= '2026-10-19' && r.date <= '2026-12-31');
    const dep = parts(r.departure, r.departureTimeZone),
      arr = parts(r.arrival, r.arrivalTimeZone);
    assert.equal(dep.date, r.date);
    assert.equal(r.arrivalTimeZone, 'Asia/Taipei');
    assert.equal(
      (Date.parse(r.arrival) - Date.parse(r.departure)) / 60000,
      r.minutes,
    );
    const file = r.evidence.file;
    if (!cache.has(file)) {
      assert.equal(await sha(file), r.sourceSha256);
      if (['JX', '7C', 'VN'].includes(folder))
        cache.set(file, await read(file));
      else cache.set(file, true);
    }
    const raw = cache.get(file);
    if (folder === 'JX') {
      const source = raw.data.timetable[r.evidence.rowIndex];
      assert.equal(source.depAirport, r.departureAirport);
      assert.equal(source.arrAirport, r.arrivalAirport);
      assert.ok(
        source.schedule.includes(r.date) && !source.cargoOnly.includes(r.date),
      );
      assert.equal(source.operatingAirlineCode, 'JX');
      assert.deepEqual(source.stops, []);
      assert.equal(source.depTime, dep.time);
      assert.equal(source.arrTime, arr.time);
      assert.equal(source.duration, r.minutes);
      assert.equal('JX' + Number(source.flightNo.slice(2)), r.number);
    } else if (folder === '7C') {
      const source = raw.data.dep[r.evidence.rowIndex];
      assert.equal(
        Date.parse(source.legDetails.departureTimeUtc),
        Date.parse(r.departure),
      );
      assert.equal(
        Date.parse(source.legDetails.arrivalTimeUtc),
        Date.parse(r.arrival),
      );
      assert.equal(source.designator.origin, r.departureAirport);
      assert.equal(source.designator.destination, r.arrivalAirport);
      assert.equal('7C' + Number(source.identifier.identifier), r.number);
    } else if (folder === 'VN') {
      const item = raw.data.departureFlight.scheduleItems[r.evidence.rowIndex];
      assert.equal(item.connectedFlights.length, 1);
      const source = item.connectedFlights[0].flightInfo;
      assert.equal(source.departureLocation.locationCode, r.departureAirport);
      assert.equal(source.arrivalLocation.locationCode, r.arrivalAirport);
      assert.equal(source.departureLocation.dateTime.slice(0, 10), r.date);
      assert.equal(source.departureLocation.dateTime.slice(11, 16), dep.time);
      assert.equal(source.arrivalLocation.dateTime.slice(11, 16), arr.time);
      assert.equal(source.operatingAirlineCode, 'VN');
      assert.equal(source.duration / 60, r.minutes);
      assert.equal('VN' + Number(source.marketingFlightNumber), r.number);
    }
  }
  const report = {
    status: 'passed',
    records: rows.length,
    sourceHashesMatch: true,
    allCoreFieldsPresent: true,
    duplicates: 0,
    timezoneAndDurationMatch: true,
    bookingInventoryConfirmed: false,
  };
  await fs.writeFile(
    base + '/independent-audit.json',
    JSON.stringify(report, null, 2),
  );
  reports.push({ folder, ...report });
}
const before = await read(root + '/website-before.json');
for (const [name, hash] of Object.entries(before))
  assert.equal(await sha('src/server/data/' + name), hash);
await fs.writeFile(
  root + '/independent-audit.json',
  JSON.stringify({ sources: reports, websiteDataUnchanged: true }, null, 2),
);
console.log(
  JSON.stringify(
    reports.map(({ folder, records, status }) => ({ folder, records, status })),
    null,
    2,
  ),
);
