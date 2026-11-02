/** Offline replay of the 2026-10-07 ordinary HTTP trials; no network requests. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const directory = path.resolve('data/source-samples/crawler/eva-http');
const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const folders = [
  'node-form-test-03',
  'node-week-test-04',
  'node-future-test-05',
  'node-restart-test-06',
];
const observations = [];
for (const folder of folders) {
  const receipt = await json(path.join(directory, folder, 'receipt.json'));
  const analysis = await json(path.join(directory, folder, 'analysis.json'));
  assert.equal(analysis.completeRequestedScope, true);
  assert.equal(analysis.verifiedDetails, analysis.records.length);
  assert.equal(receipt.browserUsed, false);
  assert.ok(
    receipt.requests.every(
      (r) => r.httpStatus === 200 && r.status === 'received',
    ),
  );
  if (folder !== 'node-form-test-03')
    assert.equal(receipt.status, 'verified_requested_scope');
  observations.push({ folder, receipt, analysis });
}
const fields = [
  'normalizedNumber',
  'departure',
  'arrival',
  'departureLocal',
  'arrivalLocal',
  'departureTimeZone',
  'arrivalTimeZone',
  'durationMinutes',
  'departureTerminal',
  'arrivalTerminal',
  'aircraft',
  'operatingAirline',
];
const canonical = (record) =>
  JSON.stringify(fields.map((field) => record[field]));
const key = (r) =>
  `${r.normalizedNumber}|${r.departure}|${r.arrival}|${r.departureLocal}`;
const [december, january, future, restart] = observations.map(
  (o) => o.analysis.records,
);
const previous = await json(
  path.resolve('data/source-samples/crawler/eva-narita-trial/analysis.json'),
);
const prior = new Map(previous.records.map((r) => [key(r), r]));
assert.equal(december.length, 3);
assert.ok(
  december.every(
    (r) => prior.has(key(r)) && canonical(r) === canonical(prior.get(key(r))),
  ),
);
const januaryDate = january.filter((r) =>
  r.departureLocal.startsWith('2027-01-15'),
);
assert.deepEqual(
  restart.map(canonical).sort(),
  januaryDate.map(canonical).sort(),
);
const unique = new Map();
for (const r of observations.flatMap((o) => o.analysis.records)) {
  if (unique.has(key(r)))
    assert.equal(canonical(unique.get(key(r))), canonical(r));
  unique.set(key(r), r);
}
const completedRuns = observations.slice(1).map((o) => ({
  folder: o.folder,
  queryDate: o.receipt.query.date,
  scope: o.analysis.scope,
  verifiedDetails: o.analysis.verifiedDetails,
  requests: o.receipt.requests.length,
  elapsedMs: Date.parse(o.receipt.finishedAt) - Date.parse(o.receipt.startedAt),
}));
const report = {
  analyzedAt: new Date().toISOString(),
  source: 'EVA official timetable',
  route: 'TPE-NRT only',
  completedAutomaticRuns: completedRuns,
  decemberCollectionValidatedSeparately: true,
  decemberMatchesEarlierBrowserObservation: true,
  independentRestartMatches: true,
  verifiedObservations: observations.reduce(
    (sum, o) => sum + o.analysis.verifiedDetails,
    0,
  ),
  uniqueFlightsThisRound: unique.size,
  newComparedWithEarlierEvaResearch: [...unique.values()].filter(
    (r) => !prior.has(key(r)),
  ).length,
  januaryDates: [
    ...new Set(january.map((r) => r.departureLocal.slice(0, 10))),
  ].sort(),
  futureDate: future[0].departureLocal.slice(0, 10),
  futureDaysAhead:
    (Date.parse(future[0].departureLocal.slice(0, 10)) -
      Date.parse('2026-10-07')) /
    86400000,
  futureRecords: future,
  integratedIntoWebsite: false,
  longTermReliabilityProven: false,
  allRoutesProven: false,
};
await fs.writeFile(
  path.join(directory, 'stability-summary.json'),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify({ ...report, futureRecords: undefined }, null, 2));
