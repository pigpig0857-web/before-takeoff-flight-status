import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const root = 'data/source-samples/crawler/ci-tpe-20261021';
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const { records } = read(`${root}/candidate-flights.json`);
const hashes = read(`${root}/evidence-hashes.json`);
for (const [file, expected] of Object.entries(hashes)) {
  assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), expected);
}
const identities = new Set();
const dates = { outbound: new Set(), return: new Set() };
for (const row of records) {
  assert.ok(row.date >= '2026-10-21' && row.date <= '2026-12-31');
  assert.equal(row.airlineCode, 'CI');
  assert.equal(row.origin, row.direction === 'outbound' ? 'TPE' : 'KIX');
  assert.equal(row.destination, row.direction === 'outbound' ? 'KIX' : 'TPE');
  assert.equal((Date.parse(row.arrival) - Date.parse(row.departure)) / 60000, row.minutes);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: row.departureTimeZone }).format(new Date(row.departure));
  assert.equal(date, row.date);
  const key = [row.origin, row.destination, row.date, row.number].join('|');
  assert.ok(!identities.has(key)); identities.add(key);
  dates[row.direction].add(row.date);
  assert.equal(hashes[row.evidence.file], row.evidence.sha256);
}
assert.equal(dates.outbound.size, 72);
assert.equal(dates.return.size, 72);
assert.equal(records.length, 432);
const report = { passed: true, records: records.length, sourceHashes: Object.keys(hashes).length,
  outboundDates: dates.outbound.size, returnDates: dates.return.size, duplicates: 0, timeZoneDurationErrors: 0,
  checkedAt: new Date().toISOString(), integratedIntoWebsite: false };
fs.writeFileSync(`${root}/independent-audit.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
