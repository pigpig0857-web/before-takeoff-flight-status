/** Validate preserved records and local source evidence without any network requests. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { comparePeachBookingQuery } from './peach-booking-evidence.mjs';
import { restorePeachProgress } from './peach-resume-state.mjs';

const root = path.resolve(process.argv[2] || '');
assert.equal(path.dirname(root), path.resolve('data/source-samples/crawler'));
const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const key = (r) => `${r.date}|${r.airport}|${r.number}`;
const snapshot = await read('src/server/data/peach-flights.json');
const checks = await read('src/server/data/peach-booking-checks.json');
const progress = await read('src/server/data/peach-verification-progress.json');
const plan = await read(path.join(root, 'resume-plan.json'));
const checkpoint = await read(path.join(root, 'run-status.json'));
const { compiled, status } = restorePeachProgress(
  snapshot.records,
  checks.records,
  progress.records,
);
assert.equal(new Set(snapshot.records.map(key)).size, snapshot.records.length);
for (const saved of plan.completedRecords)
  assert.deepEqual(compiled.get(key(saved)), saved);
const verifiedEvidence = new Map();
for (const sourceRoot of [
  path.resolve('data/source-samples/crawler/peach-detail-enrichment-20261012'),
  path.resolve('data/source-samples/crawler/peach-full-details-20261012'),
  root,
]) {
  for (const query of await read(
    path.join(sourceRoot, 'booking-checks.json'),
  )) {
    const file = path.join(
      sourceRoot,
      `${query.airport.toLowerCase()}-${query.date.replaceAll('-', '')}.txt`,
    );
    const text = await fs.readFile(file, 'utf8');
    const sha = createHash('sha256').update(text).digest('hex');
    const parsed = comparePeachBookingQuery(query, text, snapshot.records);
    assert.equal(parsed.differences.length, 0, file);
    for (const record of parsed.records) {
      const saved = compiled.get(key(record));
      assert.ok(saved, `Missing compiled record: ${key(record)}`);
      assert.equal(saved.evidenceSha256, sha);
      for (const field of [
        'date',
        'airport',
        'number',
        'departure',
        'arrival',
        'aircraft',
        'fetchedAt',
        'url',
      ]) {
        assert.equal(saved[field], record[field], `${key(record)}:${field}`);
      }
      verifiedEvidence.set(key(record), file);
    }
  }
}
for (const record of checks.records) {
  for (const field of [
    'date',
    'airport',
    'number',
    'departure',
    'arrival',
    'aircraft',
    'fetchedAt',
    'url',
    'evidenceSha256',
  ]) {
    assert.ok(
      typeof record[field] === 'string' && record[field].length,
      `${key(record)}:${field}`,
    );
  }
  assert.ok(Number.isFinite(Date.parse(record.departure)));
  assert.ok(Number.isFinite(Date.parse(record.arrival)));
  assert.ok(Number.isFinite(Date.parse(record.fetchedAt)));
  assert.ok(
    verifiedEvidence.has(key(record)),
    `Missing source evidence: ${key(record)}`,
  );
}
const summary = Object.fromEntries(
  ['verified', 'not_queried', 'not_listed', 'query_failed', 'mismatch'].map(
    (state) => [
      state,
      progress.records.filter((r) => r.state === state).length,
    ],
  ),
);
assert.deepEqual(summary, progress.summary);
assert.equal(
  Object.values(summary).reduce((a, b) => a + b, 0),
  snapshot.records.length,
);
assert.equal(summary.verified, checks.records.length);
const nextFlights = checkpoint.next.flights.map((r) =>
  status.get(
    key({ ...r, date: checkpoint.next.date, airport: checkpoint.next.airport }),
  ),
);
assert.ok(nextFlights.every((r) => r && r.state !== 'verified'));
const report = {
  checkedAt: new Date().toISOString(),
  scheduleRecords: snapshot.records.length,
  uniqueVerifiedChecks: checks.records.length,
  protectedRecords: plan.completedRecords.length,
  protectedRecordsUnchanged: true,
  sourceEvidenceVerified: verifiedEvidence.size,
  requiredFieldsValid: true,
  summary,
  next: {
    date: checkpoint.next.date,
    airport: checkpoint.next.airport,
    flights: nextFlights,
  },
  errors: [],
};
await fs.writeFile(
  path.join(root, 'saved-progress-audit.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report, null, 2));
