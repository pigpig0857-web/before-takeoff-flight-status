/** Prepare an update from replay-audited records; never overwrite live data. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { prepareUpdate } from '../flight-updates/store';
import { taipeiDate } from '../../src/lib/time';
import {
  normalizeCollected,
  type CollectedSnapshot,
} from '../../src/server/providers/collected';
async function main() {
  const root = path.resolve('data/source-samples/crawler/eva-yearend-2026');
  const audit = JSON.parse(
    await fs.readFile(path.join(root, 'audit.json'), 'utf8'),
  );
  const snapshot: CollectedSnapshot = JSON.parse(
    await fs.readFile('data/cache/eva-yearend/website-candidate.json', 'utf8'),
  );
  const details = JSON.parse(
    await fs.readFile(
      path.join(root, 'detail-crosschecks/manifest.json'),
      'utf8',
    ),
  );
  assert.equal(audit.from, '2026-10-08');
  assert.equal(audit.through, '2026-12-31');
  assert.equal(audit.days, 85);
  assert.equal(audit.records, snapshot.records.length);
  assert.equal(audit.auditedAt, snapshot.importedAt);
  assert.ok(snapshot.records.length);
  assert.ok(
    audit.routes.every((r: any) => !r.records || !r.activeMissingDates.length),
    'Some observed flight routes still have missing date coverage',
  );
  assert.ok(
    details.every(
      (d: any) => d.status === 'verified_table_detail_times_and_operator',
    ),
    'Unverified source detail checks',
  );
  for (const route of audit.routes.filter((r: any) => r.records))
    assert.ok(
      details.filter((d: any) => d.airport === route.airport).length >= 2,
      `Missing seasonal cross-check ${route.airport}`,
    );
  for (const detail of details) {
    const r = snapshot.records.find(
      (r) =>
        r.airport === detail.airport &&
        r.date === detail.date &&
        r.number === detail.number,
    );
    assert.ok(r);
    assert.equal(
      r.minutes,
      detail.durationMinutes,
      `Detail/table UTC duration mismatch ${r.number} ${r.date}`,
    );
  }
  snapshot.records.forEach(normalizeCollected);
  assert.ok(
    snapshot.records.every(
      (r) =>
        r.date >= audit.from &&
        r.date <= audit.through &&
        r.kind === 'collected_eva',
    ),
  );
  const result = await prepareUpdate(
    path.resolve('.'),
    'eva',
    'data/cache/eva-yearend/website-candidate.json',
    taipeiDate(),
  );
  console.log(
    JSON.stringify(
      {
        ...result,
        integratedIntoWebsite: false,
        message: 'Preview only; review the update package before applying.',
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
