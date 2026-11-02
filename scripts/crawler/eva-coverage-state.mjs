/** Pure planning and coverage accounting. A missing observation never means no flight. */
import assert from 'node:assert/strict';
const dayMs = 86400000;
export const reviewedRoutes = { NRT: 7, ICN: 3, BKK: 3, SFO: 7 };
export function datesBetween(from, through) {
  for (const date of [from, through]) {
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(new Date(date).toISOString().slice(0, 10), date);
  }
  assert.ok(
    from <= through && Date.parse(through) - Date.parse(from) <= 366 * dayMs,
  );
  const dates = [];
  for (
    let instant = Date.parse(from);
    instant <= Date.parse(through);
    instant += dayMs
  )
    dates.push(new Date(instant).toISOString().slice(0, 10));
  return dates;
}
export function createPlan(from, through, catalog) {
  const dates = datesBetween(from, through);
  assert.ok(
    catalog.length &&
      new Set(catalog.map((r) => r.value)).size === catalog.length,
  );
  const pending = Object.entries(reviewedRoutes).map(([arrival, size]) => {
    assert.ok(catalog.some((r) => r.value.endsWith(arrival)));
    return dates.reduce((jobs, _, i) => {
      if (i % size === 0) {
        const group = dates.slice(i, i + size);
        jobs.push({
          id: `${arrival}-${group[0]}`,
          arrival,
          from: group[0],
          through: group.at(-1),
          queryDate: group[Math.floor(group.length / 2)],
          status: 'pending',
          attempts: [],
        });
      }
      return jobs;
    }, []);
  });
  // Interleave routes, giving each an initial observation before extending it.
  const jobs = [];
  for (let i = 0; pending.some((group) => i < group.length); i++)
    for (const group of pending) if (group[i]) jobs.push(group[i]);
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    source: 'EVA official published timetable',
    from,
    through,
    routeInventoryComplete: false,
    allDatesComplete: false,
    catalog: catalog.map((r) => ({
      ...r,
      airport: r.value.slice(-3),
      status: ['TPETPE', 'TPETSA', 'KHHKHH', 'RMQRMQ'].includes(r.value)
        ? 'excluded_origin_or_domestic'
        : r.value === 'OSAOSA'
          ? 'city_selection_not_an_airport'
          : Object.hasOwn(reviewedRoutes, r.value.slice(-3))
            ? 'reviewed_parser'
            : 'needs_route_and_parser_review',
      directServiceProven: false,
    })),
    jobs,
  };
}
export function ingestVerifiedJob(
  job,
  receipt,
  analysis,
  sampleDir,
  { offlineRecovery = false } = {},
) {
  assert.deepEqual(receipt.query, {
    departure: 'TPE',
    arrival: job.arrival,
    date: job.queryDate,
  });
  if (offlineRecovery) {
    assert.equal(receipt.status, 'failed');
    assert.ok(
      Date.parse(analysis.analyzedAt) >= Date.parse(receipt.finishedAt),
    );
    assert.equal(receipt.requests.length, analysis.records.length + 2);
    assert.ok(
      receipt.requests.every(
        (r) => r.status === 'received' && r.httpStatus === 200,
      ),
    );
  } else assert.equal(receipt.status, 'verified_requested_scope');
  assert.equal(analysis.scope, 'requested_range');
  assert.equal(analysis.completeRequestedScope, true);
  assert.equal(analysis.requestedFrom, job.from);
  assert.equal(analysis.requestedThrough, job.through);
  assert.equal(analysis.verifiedDetails, analysis.records.length);
  assert.ok(
    receipt.publishedDateMin <= job.from &&
      receipt.publishedDateMax >= job.through,
  );
  const days = datesBetween(job.from, job.through);
  assert.ok(
    analysis.records.every(
      (r) =>
        r.departure === 'TPE' &&
        r.arrival === job.arrival &&
        days.includes(r.departureLocal.slice(0, 10)) &&
        ['BR', 'TG', 'OZ'].includes(r.operatingAirlineCode),
    ),
  );
  const identities = analysis.records.map(
    (r) => `${r.normalizedNumber}|${r.departureLocal}`,
  );
  assert.equal(new Set(identities).size, identities.length);
  const coverage = days.map((date) => {
    const records = analysis.records.filter((r) =>
      r.departureLocal.startsWith(date),
    );
    return {
      date,
      arrival: job.arrival,
      status: 'verified_observed_table_scope',
      observedAt: receipt.finishedAt,
      sampleDir,
      evaOperatedRecords: records.filter(
        (r) => r.operatingAirlineCode === 'BR',
      ),
      otherOperatorRecords: records.filter(
        (r) => r.operatingAirlineCode !== 'BR',
      ),
      // This is only a table observation, never an assertion of no bookable flight.
      observation: records.some((r) => r.operatingAirlineCode === 'BR')
        ? 'eva_services_observed'
        : 'no_eva_service_in_observed_table',
    };
  });
  return {
    ...job,
    status: 'verified',
    coverage,
    sampleDir,
    verifiedAt: offlineRecovery ? analysis.analyzedAt : receipt.finishedAt,
    validationMode: offlineRecovery
      ? 'offline_recovered_after_parser_review'
      : 'automatic_during_collection',
  };
}
export function splitUncoveredWindow(job, observedDates) {
  assert.equal(job.status, 'failed');
  assert.ok(observedDates.length === 7);
  assert.deepEqual(
    datesBetween(observedDates[0], observedDates.at(-1)),
    observedDates,
  );
  const wanted = datesBetween(job.from, job.through);
  const covered = wanted.filter((date) => observedDates.includes(date));
  assert.ok(covered.length > 0 && covered.length < wanted.length);
  const groups = [
    covered,
    wanted.filter((d) => d < covered[0]),
    wanted.filter((d) => d > covered.at(-1)),
  ].filter((g) => g.length);
  return groups.map((dates) => ({
    id: `${job.id}-split-${dates[0]}`,
    arrival: job.arrival,
    from: dates[0],
    through: dates.at(-1),
    queryDate: dates[Math.floor(dates.length / 2)],
    status: 'pending',
    attempts: [],
    parent: job.id,
  }));
}
export function splitLargeJob(job, size) {
  assert.ok(['failed', 'pending'].includes(job.status));
  assert.ok(
    Number.isInteger(size) &&
      size >= 1 &&
      size < datesBetween(job.from, job.through).length,
  );
  const dates = datesBetween(job.from, job.through);
  const children = [];
  for (let i = 0; i < dates.length; i += size) {
    const group = dates.slice(i, i + size);
    children.push({
      id: `${job.id}-batch-${group[0]}`,
      arrival: job.arrival,
      from: group[0],
      through: group.at(-1),
      queryDate: group[Math.floor(group.length / 2)],
      status: 'pending',
      attempts: [],
      parent: job.id,
    });
  }
  return children;
}
export function summarize(plan) {
  const coverage = plan.jobs
    .filter((j) => j.status === 'verified')
    .flatMap((j) => j.coverage);
  return {
    from: plan.from,
    through: plan.through,
    routeInventoryComplete: false,
    plannedRouteDates:
      datesBetween(plan.from, plan.through).length *
      Object.keys(reviewedRoutes).length,
    verifiedRouteDates: coverage.length,
    pendingJobs: plan.jobs.filter((j) => j.status === 'pending').length,
    interruptedJobs: plan.jobs.filter((j) => j.status === 'running').length,
    failedJobs: plan.jobs.filter((j) => j.status === 'failed').length,
    evaOperatedMarketingRecords: coverage.reduce(
      (sum, c) => sum + c.evaOperatedRecords.length,
      0,
    ),
    otherOperatorRecords: coverage.reduce(
      (sum, c) => sum + c.otherOperatorRecords.length,
      0,
    ),
    allDatesComplete: plan.jobs.every((j) => j.status === 'verified'),
    integratedIntoWebsite: false,
  };
}
