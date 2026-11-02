import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Research runner is JavaScript, outside the application's TS build.
import * as coverage from '../scripts/crawler/eva-coverage-state.mjs';
const {
  createPlan,
  ingestVerifiedJob,
  summarize,
  splitUncoveredWindow,
  splitLargeJob,
} = coverage;

const catalog = ['TYONRT', 'SELICN', 'BKKBKK', 'SFOSFO', 'OSAOSA'].map(
  (value) => ({ value, label: value }),
);
test('Oversized failed batches retain every date when split and keep prior attempts', () => {
  const job = {
    id: 'ICN-week',
    arrival: 'ICN',
    from: '2026-10-14',
    through: '2026-10-20',
    status: 'failed',
    attempts: [{ status: 'failed' }],
  };
  const children = splitLargeJob(job, 3);
  assert.deepEqual(
    children.map((j: { from: string; through: string }) => [j.from, j.through]),
    [
      ['2026-10-14', '2026-10-16'],
      ['2026-10-17', '2026-10-19'],
      ['2026-10-20', '2026-10-20'],
    ],
  );
  assert.equal(job.attempts.length, 1);
  assert.throws(() => splitLargeJob({ ...job, status: 'verified' }, 3));
  assert.throws(() => splitLargeJob(job, 0));
});
test('A shifted source window splits the missing boundary without declaring it complete', () => {
  const job = {
    id: 'NRT-2026-10-07',
    arrival: 'NRT',
    from: '2026-10-07',
    through: '2026-10-13',
    status: 'failed',
  };
  const window = [
    '2026-10-08',
    '2026-10-09',
    '2026-10-10',
    '2026-10-11',
    '2026-10-12',
    '2026-10-13',
    '2026-10-14',
  ];
  const split = splitUncoveredWindow(job, window);
  assert.deepEqual(
    split.map((j: { from: string; through: string; status: string }) => [
      j.from,
      j.through,
      j.status,
    ]),
    [
      ['2026-10-08', '2026-10-13', 'pending'],
      ['2026-10-07', '2026-10-07', 'pending'],
    ],
  );
  assert.throws(() => splitUncoveredWindow(job, window.slice(1)));
  assert.throws(() =>
    splitUncoveredWindow({ ...job, status: 'verified' }, window),
  );
});
test('Coverage planner includes each route/date once, handles leap day and short final chunks', () => {
  const plan = createPlan('2028-02-27', '2028-03-06', catalog);
  assert.equal(summarize(plan).plannedRouteDates, 36);
  const jobs = plan.jobs as {
    arrival: string;
    from: string;
    through: string;
  }[];
  for (const arrival of ['NRT', 'ICN', 'BKK', 'SFO']) {
    const days: string[] = [];
    for (const job of jobs.filter((j) => j.arrival === arrival))
      for (
        let date = Date.parse(job.from);
        date <= Date.parse(job.through);
        date += 86400000
      )
        days.push(new Date(date).toISOString().slice(0, 10));
    assert.equal(days.length, 9);
    assert.equal(new Set(days).size, 9);
    assert.ok(days.includes('2028-02-29'));
  }
  assert.equal(summarize(plan).verifiedRouteDates, 0);
  assert.equal(plan.catalog.at(-1).directServiceProven, false);
  assert.equal(plan.routeInventoryComplete, false);
});

function verifiedFixture() {
  const plan = createPlan('2027-01-12', '2027-01-18', catalog);
  const job = plan.jobs.find((j: { arrival: string }) => j.arrival === 'BKK');
  const record = {
    normalizedNumber: 'BR61',
    departure: 'TPE',
    arrival: 'BKK',
    departureLocal: '2027-01-12T22:30:00+08:00',
    operatingAirlineCode: 'BR',
  };
  const receipt = {
    query: { departure: 'TPE', arrival: 'BKK', date: job.queryDate },
    status: 'verified_requested_scope',
    publishedDateMin: '2026-10-07',
    publishedDateMax: '2027-10-02',
    finishedAt: '2026-10-07T03:00:00Z',
  };
  const analysis = {
    scope: 'requested_range',
    completeRequestedScope: true,
    requestedFrom: job.from,
    requestedThrough: job.through,
    verifiedDetails: 2,
    records: [
      record,
      { ...record, normalizedNumber: 'BR2219', operatingAirlineCode: 'TG' },
    ],
  };
  return { plan, job, receipt, analysis };
}
test('Verified coverage separates other operators and does not infer daily service', () => {
  const { job, receipt, analysis } = verifiedFixture();
  const completed = ingestVerifiedJob(job, receipt, analysis, 'local-sample');
  assert.equal(completed.coverage.length, 3);
  assert.equal(completed.coverage[0].evaOperatedRecords.length, 1);
  assert.equal(completed.coverage[0].otherOperatorRecords.length, 1);
  assert.equal(
    completed.coverage[1].observation,
    'no_eva_service_in_observed_table',
  );
});
test('Offline recovery requires a later validation and complete successful HTTP evidence', () => {
  const { job, receipt, analysis } = verifiedFixture();
  const failedReceipt = {
    ...receipt,
    status: 'failed',
    requests: Array.from({ length: 4 }, () => ({
      status: 'received',
      httpStatus: 200,
    })),
  };
  const laterAnalysis = { ...analysis, analyzedAt: '2026-10-07T03:05:00Z' };
  assert.equal(
    ingestVerifiedJob(job, failedReceipt, laterAnalysis, 'sample', {
      offlineRecovery: true,
    }).validationMode,
    'offline_recovered_after_parser_review',
  );
  assert.throws(() =>
    ingestVerifiedJob(
      job,
      { ...failedReceipt, requests: failedReceipt.requests.slice(1) },
      laterAnalysis,
      'sample',
      { offlineRecovery: true },
    ),
  );
  assert.throws(() =>
    ingestVerifiedJob(
      job,
      failedReceipt,
      { ...laterAnalysis, analyzedAt: '2026-10-07T02:59:00Z' },
      'sample',
      { offlineRecovery: true },
    ),
  );
});
test('Coverage refuses wrong dates, other destinations, duplicate identities and failed receipts', () => {
  const { job, receipt, analysis } = verifiedFixture();
  assert.throws(() =>
    ingestVerifiedJob(
      job,
      { ...receipt, status: 'failed' },
      analysis,
      'sample',
    ),
  );
  assert.throws(() =>
    ingestVerifiedJob(
      job,
      receipt,
      { ...analysis, requestedThrough: '2027-01-18' },
      'sample',
    ),
  );
  assert.throws(() =>
    ingestVerifiedJob(
      job,
      receipt,
      { ...analysis, records: [analysis.records[0], analysis.records[0]] },
      'sample',
    ),
  );
  assert.throws(() =>
    ingestVerifiedJob(
      job,
      receipt,
      {
        ...analysis,
        records: [
          analysis.records[0],
          { ...analysis.records[1], arrival: 'ICN' },
        ],
      },
      'sample',
    ),
  );
});
test('Saved progress resumes pending work without counting a failure or interrupted job as complete', () => {
  const { plan, job, receipt, analysis } = verifiedFixture();
  Object.assign(job, ingestVerifiedJob(job, receipt, analysis, 'sample'));
  plan.jobs[0].status = 'failed';
  plan.jobs[1].status = 'running';
  const restarted = JSON.parse(JSON.stringify(plan));
  assert.equal(summarize(restarted).verifiedRouteDates, 3);
  assert.equal(summarize(restarted).failedJobs, 1);
  assert.equal(summarize(restarted).interruptedJobs, 1);
  assert.equal(
    restarted.jobs.filter((j: { status: string }) => j.status === 'pending')
      .length,
    summarize(restarted).pendingJobs,
  );
  assert.equal(summarize(restarted).allDatesComplete, false);
});
