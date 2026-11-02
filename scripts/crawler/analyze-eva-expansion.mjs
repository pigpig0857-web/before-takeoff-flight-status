/** Offline audit of the saved 2026-10-07 expansion trials; no source requests. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const directory = path.resolve('data/source-samples/crawler/eva-expansion');
const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const trials = [
  ['icn-first', 'ICN', '2027-01-15', 4, false],
  ['bkk-first', 'BKK', '2027-01-15', 6, false],
  ['sfo-first', 'SFO', '2027-01-15', 3, false],
  ['bkk-overnight-first', 'BKK', '2027-01-12', 8, false],
  ['sfo-summer', 'SFO', '2027-09-30', 3, true],
  ['icn-restart', 'ICN', '2027-01-15', 4, true],
  ['bkk-overnight-restart', 'BKK', '2027-01-12', 8, true],
];
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
  'marketingAirline',
  'operatingAirline',
  'sourceOperatingAirlineLabel',
  'operatingAirlineCode',
  'operatingNumber',
  'isCodeshare',
  'dataKind',
];
const canonical = (record) =>
  JSON.stringify(fields.map((field) => record[field]));
const key = (r) =>
  `${r.normalizedNumber}|${r.departure}|${r.arrival}|${r.departureLocal}`;
const observations = [];
const unique = new Map();
for (const [folder, arrival, date, count, automaticValidation] of trials) {
  const receipt = await json(path.join(directory, folder, 'receipt.json'));
  const analysis = await json(path.join(directory, folder, 'analysis.json'));
  assert.deepEqual(receipt.query, { departure: 'TPE', arrival, date });
  assert.equal(receipt.browserUsed, false);
  assert.equal(analysis.completeRequestedScope, true);
  assert.equal(analysis.completeObservedWeek, false);
  assert.equal(analysis.verifiedDetails, count);
  assert.equal(analysis.records.length, count);
  assert.equal(receipt.requests.length, count + 2);
  assert.ok(
    receipt.requests.every(
      (r) => r.httpStatus === 200 && r.status === 'received',
    ),
  );
  assert.equal(
    receipt.status,
    automaticValidation
      ? 'verified_requested_scope'
      : 'research_details_received_not_validated',
  );
  for (const r of analysis.records) {
    assert.equal(r.arrival, arrival);
    assert.ok(r.departureLocal.startsWith(date));
    assert.equal(r.operatingNumber, null);
    if (unique.has(key(r)))
      assert.equal(canonical(unique.get(key(r))), canonical(r));
    unique.set(key(r), r);
  }
  observations.push({ folder, receipt, analysis, automaticValidation });
}
const restarts = [
  ['icn-first', 'icn-restart'],
  ['bkk-overnight-first', 'bkk-overnight-restart'],
].map(([first, restart]) => {
  const get = (folder) =>
    observations.find((o) => o.folder === folder).analysis.records;
  assert.deepEqual(
    get(first).map(canonical).sort(),
    get(restart).map(canonical).sort(),
  );
  return { first, restart, consistentRecords: get(first).length };
});
const website = await json(
  path.resolve('src/server/data/collected-flights.json'),
);
const numberKey = (n) => n.replace(/^(BR|B7)0+(?=\d)/, '$1');
const websiteKey = (r) => `${numberKey(r.number)}|${r.airport}|${r.date}`;
const onWebsite = new Map(
  website.records.filter((r) => r.airport).map((r) => [websiteKey(r), r]),
);
let sameDeparture = 0;
const changedDeparture = [];
const websiteArrivalDifferences = [];
const newIdentities = [];
for (const r of unique.values()) {
  const existing = onWebsite.get(
    `${r.normalizedNumber}|${r.arrival}|${r.departureLocal.slice(0, 10)}`,
  );
  if (!existing) newIdentities.push(key(r));
  else if (Date.parse(existing.departure) === Date.parse(r.departureLocal))
    sameDeparture++;
  else
    changedDeparture.push({
      identity: key(r),
      websiteDeparture: existing.departure,
      observedDeparture: r.departureLocal,
    });
  if (
    existing &&
    (Date.parse(existing.arrival) !== Date.parse(r.arrivalLocal) ||
      existing.minutes !== r.durationMinutes)
  )
    websiteArrivalDifferences.push({
      identity: key(r),
      websiteArrival: existing.arrival,
      observedArrival: r.arrivalLocal,
      websiteMinutes: existing.minutes,
      observedMinutes: r.durationMinutes,
    });
}
const report = {
  analyzedAt: new Date().toISOString(),
  testedRoutes: ['TPE-ICN', 'TPE-BKK', 'TPE-SFO'],
  runs: observations.map((o) => ({
    folder: o.folder,
    query: o.receipt.query,
    records: o.analysis.records.length,
    requests: o.receipt.requests.length,
    automaticValidation: o.automaticValidation,
    startedAt: o.receipt.startedAt,
    finishedAt: o.receipt.finishedAt,
    elapsedMs:
      Date.parse(o.receipt.finishedAt) - Date.parse(o.receipt.startedAt),
  })),
  verifiedObservations: observations.reduce(
    (sum, o) => sum + o.analysis.records.length,
    0,
  ),
  uniqueMarketingFlightDateRecords: unique.size,
  requests: observations.reduce((sum, o) => sum + o.receipt.requests.length, 0),
  allRequestsHttp200: true,
  restarts,
  uniqueCodeshareRecords: [...unique.values()].filter((r) => r.isCodeshare)
    .length,
  uniqueMissingAircraftRecords: [...unique.values()].filter((r) => !r.aircraft)
    .length,
  websiteSnapshotRecords: website.records.length,
  alreadyOnWebsiteWithSameDeparture: sameDeparture,
  changedDeparture,
  websiteArrivalDifferences,
  newIdentitiesComparedWithWebsite: newIdentities,
  integratedIntoWebsite: false,
  allDatesCollected: false,
  longTermReliabilityProven: false,
  records: [...unique.values()],
};
await fs.writeFile(
  path.join(directory, 'expansion-summary.json'),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify({ ...report, records: undefined }, null, 2));
