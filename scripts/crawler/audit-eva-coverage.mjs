/** Offline audit: verify progress is backed by saved evidence and retains every gap. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  datesBetween,
  reviewedRoutes,
  ingestVerifiedJob,
  summarize,
} from './eva-coverage-state.mjs';
const args = process.argv.slice(2);
const directory = path.resolve(args[args.indexOf('--run-dir') + 1]);
const relative = path.relative(
  path.resolve('data/source-samples/crawler'),
  directory,
);
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const plan = await json(path.join(directory, 'progress.json'));
const partition = plan.jobs
  .filter((j) => j.status !== 'split')
  .flatMap((j) =>
    datesBetween(j.from, j.through).map((d) => `${j.arrival}|${d}`),
  );
assert.equal(new Set(partition).size, partition.length);
assert.equal(
  partition.length,
  datesBetween(plan.from, plan.through).length *
    Object.keys(reviewedRoutes).length,
);
const completed = [];
const attempts = [];
for (const job of plan.jobs) {
  for (const attempt of job.attempts) {
    const receipt = await json(path.join(attempt.sampleDir, 'receipt.json'));
    attempts.push({
      job: job.id,
      sampleDir: attempt.sampleDir,
      status: receipt.status,
      error: receipt.error,
      requests: receipt.requests.length,
      allRequests200: receipt.requests.every(
        (r) => r.httpStatus === 200 && r.status === 'received',
      ),
      startedAt: receipt.startedAt,
      finishedAt: receipt.finishedAt,
    });
  }
  if (job.status !== 'verified') continue;
  const receipt = await json(path.join(job.sampleDir, 'receipt.json'));
  const analysis = await json(path.join(job.sampleDir, 'analysis.json'));
  const verified = ingestVerifiedJob(job, receipt, analysis, job.sampleDir, {
    offlineRecovery:
      job.validationMode === 'offline_recovered_after_parser_review',
  });
  assert.deepEqual(job.coverage, verified.coverage);
  completed.push({
    id: job.id,
    arrival: job.arrival,
    from: job.from,
    through: job.through,
    verifiedDates: job.coverage.length,
    records: analysis.records.length,
    validationMode: job.validationMode,
    sourceReceiptStatus: receipt.status,
  });
}
const snapshot = await json(
  path.resolve('src/server/data/collected-flights.json'),
);
const catalogStatus = {};
for (const row of plan.catalog)
  catalogStatus[row.status] = (catalogStatus[row.status] ?? 0) + 1;
const report = {
  auditedAt: new Date().toISOString(),
  ...summarize(plan),
  publishedSelectorItems: plan.catalog.length,
  catalogStatus,
  completed,
  attempts,
  requests: attempts.reduce((sum, a) => sum + a.requests, 0),
  allSourceRequests200: attempts.every((a) => a.allRequests200),
  missingBoundaryDates: plan.jobs
    .filter((j) => j.parent && j.status !== 'verified')
    .map((j) => ({
      arrival: j.arrival,
      from: j.from,
      through: j.through,
      status: j.status,
    })),
  websiteSnapshotRecordCount: snapshot.records.length,
  longTermReliabilityProven: false,
  allEvaDirectRoutesConfirmed: false,
};
await fs.writeFile(
  path.join(directory, 'audit.json'),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
