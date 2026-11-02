import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { comparePeachBookingQuery } from './peach-booking-evidence.mjs';
import {
  restorePeachProgress,
  addPeachVerifiedCheck,
} from './peach-resume-state.mjs';
const root = path.resolve(process.argv[2] || '');
if (path.dirname(root) !== path.resolve('data/source-samples/crawler'))
  throw new Error('Evidence directory outside crawler sources');
const snapshot = JSON.parse(
  await fs.readFile('src/server/data/peach-flights.json', 'utf8'),
);
const previous = JSON.parse(
  await fs.readFile('src/server/data/peach-booking-checks.json', 'utf8'),
);
const previousProgress = JSON.parse(
  await fs.readFile('src/server/data/peach-verification-progress.json', 'utf8'),
);
const observations = JSON.parse(
  await fs.readFile(path.join(root, 'booking-checks.json'), 'utf8'),
);
const key = (r) => `${r.date}|${r.airport}|${r.number}`;
const { compiled, status } = restorePeachProgress(
  snapshot.records,
  previous.records,
  previousProgress.records,
);
for (const check of previous.records) {
  const saved = snapshot.records.find((r) => key(r) === key(check));
  if (
    !saved ||
    saved.departure !== check.departure ||
    saved.arrival !== check.arrival ||
    check.url !== 'https://booking.flypeach.com/en/' ||
    !Number.isFinite(Date.parse(check.fetchedAt))
  )
    throw new Error('Existing booking evidence does not match snapshot');
  if (status.get(key(check)).state !== 'verified')
    throw new Error('Completed check and saved progress disagree');
}
const differences = [],
  queryResults = [];
let added = 0;
for (const query of observations) {
  if (
    !['KIX', 'NRT', 'HND', 'NGO', 'OKA'].includes(query.airport) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(query.date)
  )
    throw new Error('Invalid evidence filename parameters');
  const text = await fs.readFile(
    path.join(
      root,
      `${query.airport.toLowerCase()}-${query.date.replaceAll('-', '')}.txt`,
    ),
    'utf8',
  );
  const result = comparePeachBookingQuery(query, text, snapshot.records);
  const evidenceSha256 = createHash('sha256').update(text).digest('hex');
  for (const check of result.records) {
    // Completed evidence is immutable during a resume. A query may contain
    // several flights; only previously unfinished records are added.
    if (addPeachVerifiedCheck(compiled, status, check, evidenceSha256)) added++;
  }
  for (const missing of result.missing)
    if (!compiled.has(key(missing))) status.set(key(missing), missing);
  for (const difference of result.differences) {
    differences.push({
      date: query.date,
      airport: query.airport,
      ...difference,
    });
    const id = `${query.date}|${query.airport}|${difference.number}`;
    if (status.has(id) && !compiled.has(id))
      status.set(id, {
        ...status.get(id),
        state: 'mismatch',
        checkedAt: query.fetchedAt,
        reason: difference.reason,
      });
  }
  queryResults.push({
    date: query.date,
    airport: query.airport,
    listed: query.rows.length,
    matched: result.records.length,
    notListed: result.missing.length,
    differences: result.differences.length,
  });
}
let failures = [];
try {
  failures = JSON.parse(
    await fs.readFile(path.join(root, 'query-failures.json'), 'utf8'),
  );
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
for (const failed of failures) {
  if (
    failed.status !== 'access_denied' ||
    !Number.isFinite(Date.parse(failed.observedAt))
  )
    throw new Error('Unreviewed query failure');
  for (const r of snapshot.records.filter(
    (r) => r.date === failed.date && r.airport === failed.airport,
  )) {
    const current = status.get(key(r));
    if (
      compiled.has(key(r)) ||
      (current.checkedAt &&
        Date.parse(current.checkedAt) > Date.parse(failed.observedAt))
    )
      continue;
    status.set(key(r), {
      date: r.date,
      airport: r.airport,
      number: r.number,
      state: 'query_failed',
      checkedAt: failed.observedAt,
      reason: 'access_denied',
    });
  }
}
const records = [...compiled.values()].sort(
  (a, b) =>
    a.date.localeCompare(b.date) ||
    a.airport.localeCompare(b.airport) ||
    a.number.localeCompare(b.number),
);
const progress = [...status.values()];
let resumePlan = null;
try {
  resumePlan = JSON.parse(
    await fs.readFile(path.join(root, 'resume-plan.json'), 'utf8'),
  );
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
if (resumePlan) {
  for (const protectedRecord of resumePlan.completedRecords) {
    if (
      JSON.stringify(compiled.get(key(protectedRecord))) !==
      JSON.stringify(protectedRecord)
    )
      throw new Error('Previously completed evidence was modified');
  }
}
const summary = Object.fromEntries(
  ['verified', 'not_queried', 'not_listed', 'query_failed', 'mismatch'].map(
    (state) => [state, progress.filter((r) => r.state === state).length],
  ),
);
const report = {
  importedAt: new Date().toISOString(),
  total: snapshot.records.length,
  previousChecks: previous.records.length,
  added,
  checksWithAircraft: records.length,
  summary,
  queryResults,
  differences,
  failures,
  allFlightsVerified: summary.verified === snapshot.records.length,
  datedTerminalsProvided: 0,
  protectedCompleted: resumePlan?.initialCompleted ?? previous.records.length,
  protectedRecordsUnchanged: true,
};
if (process.argv.includes('--dry-run')) {
  console.log(
    JSON.stringify(
      { ...report, queryResults: undefined, dryRun: true },
      null,
      2,
    ),
  );
  process.exit(0);
}
try {
  await fs.writeFile(
    path.join(root, 'previous-booking-checks.json'),
    JSON.stringify(previous, null, 2),
    { flag: 'wx' },
  );
} catch (e) {
  if (e.code !== 'EEXIST') throw e;
}
await fs.writeFile(
  path.join(root, 'import-audit.json'),
  JSON.stringify(report, null, 2),
);
for (const [file, value] of [
  ['src/server/data/peach-booking-checks.json', { version: 1, records }],
  [
    'src/server/data/peach-verification-progress.json',
    { version: 1, updatedAt: report.importedAt, summary, records: progress },
  ],
]) {
  if (file.endsWith('peach-booking-checks.json') && added === 0) continue;
  if (
    file.endsWith('peach-verification-progress.json') &&
    JSON.stringify(previousProgress.records) === JSON.stringify(value.records)
  )
    continue;
  await fs.writeFile(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  await fs.rename(file + '.tmp', file);
}
console.log(JSON.stringify({ ...report, queryResults: undefined }, null, 2));
