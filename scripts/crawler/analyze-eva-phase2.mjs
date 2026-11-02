/** Offline incremental audit; count only evidence added after the saved baseline. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve('data/source-samples/crawler/eva-coverage-trial');
const json = async (file) =>
  JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
const baseline = await json('phase2-baseline.json');
const current = await json('phase2-audit.json');
const plan = await json('phase2-progress.json');
const priorIds = new Set(baseline.completed.map((j) => j.id));
const newJobs = current.completed.filter((j) => !priorIds.has(j.id));
const records = [];
for (const completed of newJobs) {
  const job = plan.jobs.find((j) => j.id === completed.id);
  records.push(
    ...JSON.parse(
      await fs.readFile(path.join(job.sampleDir, 'analysis.json'), 'utf8'),
    ).records,
  );
}
const identity = (r) =>
  `${r.normalizedNumber}|${r.arrival}|${r.departureLocal}`;
assert.equal(new Set(records.map(identity)).size, records.length);
assert.equal(
  current.verifiedRouteDates - baseline.verifiedRouteDates,
  newJobs.reduce((n, j) => n + j.verifiedDates, 0),
);
const fields = [
  'normalizedNumber',
  'departure',
  'arrival',
  'departureLocal',
  'arrivalLocal',
  'durationMinutes',
  'departureTerminal',
  'arrivalTerminal',
  'aircraft',
  'marketingAirline',
  'operatingAirlineCode',
  'operatingNumber',
];
const canonical = (r) => JSON.stringify(fields.map((f) => r[f]));
const review = await json('icn-format-review-01/analysis.json');
const repeated = records.filter(
  (r) => r.arrival === 'ICN' && r.departureLocal.startsWith('2026-10-17'),
);
assert.equal(review.records.length, 6);
assert.deepEqual(
  review.records.map(canonical).sort(),
  repeated.map(canonical).sort(),
);
const extraSamples = [];
for (const arrival of ['KIX', 'LAX']) {
  const directory = `${arrival.toLowerCase()}-format-review-01`;
  const receipt = await json(`${directory}/receipt.json`);
  const analysis = await json(`${directory}/analysis.json`);
  assert.equal(receipt.status, 'research_details_received_not_validated');
  assert.equal(analysis.completeRequestedScope, true);
  assert.equal(analysis.verifiedDetails, 3);
  assert.ok(
    analysis.records.every(
      (r) =>
        r.arrival === arrival &&
        r.operatingAirlineCode === 'BR' &&
        r.departureLocal.startsWith('2026-10-14'),
    ),
  );
  assert.ok(
    receipt.requests.every(
      (r) => r.httpStatus === 200 && r.status === 'received',
    ),
  );
  extraSamples.push({
    arrival,
    date: '2026-10-14',
    records: analysis.records,
    requests: receipt.requests.length,
    validationMode: 'offline_review_after_research_capture',
    includedInProgress: false,
  });
}
const extraCount = extraSamples.reduce((n, s) => n + s.records.length, 0);
const report = {
  analyzedAt: new Date().toISOString(),
  addedRouteDates: current.verifiedRouteDates - baseline.verifiedRouteDates,
  addedVerifiedRecords: records.length + extraCount,
  addedProgressRecords: records.length,
  addedSingleDateSampleRecords: extraCount,
  addedEvaOperatedMarketingRecords:
    records.filter((r) => r.operatingAirlineCode === 'BR').length + extraCount,
  addedOtherOperatorRecords: records.filter(
    (r) => r.operatingAirlineCode !== 'BR',
  ).length,
  icnIndependentSameDayRepeatMatches: true,
  repeatedIcnRecords: repeated.length,
  newJobs,
  extraSamples,
  // Some new attempts may be inserted before old jobs in the journal; compare paths instead.
  attemptsAddedByPath: current.attempts.filter(
    (a) => !baseline.attempts.some((b) => a.sampleDir === b.sampleDir),
  ),
  totalVerifiedRouteDates: current.verifiedRouteDates,
  plannedRouteDates: current.plannedRouteDates,
  totalProgressMarketingRecords:
    current.evaOperatedMarketingRecords + current.otherOperatorRecords,
  totalVerifiedMarketingRecordsIncludingExtraSamples:
    current.evaOperatedMarketingRecords +
    current.otherOperatorRecords +
    extraCount,
  integratedIntoWebsite: false,
  longTermReliabilityProven: false,
};
await fs.writeFile(
  path.join(root, 'phase2-summary.json'),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
