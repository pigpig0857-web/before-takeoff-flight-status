import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { taipeiDate } from '../../src/lib/time';
import { compareObservation } from './compare';
import { buildGroups, sha } from './sources';
import type { CollectedSnapshot } from '../../src/server/providers/collected';
import type { VerificationLedger } from '../../src/server/services/timetable-verification';

export function validateBrowserJta(
  fresh: any,
  baseline: any,
  now = Date.now(),
) {
  assert.equal(
    fresh.sourceUrl,
    'https://www.jal.co.jp/tw/en/offers/okinawa-jta/',
  );
  assert.equal(fresh.method, 'ordinary_browser_public_dom');
  assert.equal(fresh.authenticated, false);
  assert.ok(
    Number.isFinite(Date.parse(fresh.capturedAt)) &&
      Date.parse(fresh.capturedAt) <= now + 60000 &&
      now - Date.parse(fresh.capturedAt) < 24 * 3600_000,
    'Browser evidence is not current',
  );
  assert.deepEqual(
    fresh.periodHeadings,
    baseline.periodHeadings,
    'Published seasons changed',
  );
  assert.ok(Array.isArray(fresh.tables) && fresh.tables.length === 2);
  const clean = (s: string) => s.normalize('NFKC').replace(/\s+/g, '');
  const table = (t: any) => t.rows.map((r: string[]) => r.map(clean));
  // Whole tables are compared, including all operation days and date exceptions.
  assert.deepEqual(
    fresh.tables.map(table),
    baseline.tables.map(table),
    'JTA schedule/footnotes changed; do not refresh the timestamp',
  );
}
async function atomic(file: string, value: unknown) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
  await fs.rename(tmp, file);
}
export async function applyBrowserJta(file: string) {
  const base = path.resolve('data/automatic-verification'),
    root = path.join(base, 'runs', taipeiDate());
  const actual = path.resolve(file);
  assert.ok(
    actual.startsWith(root + path.sep),
    "Browser capture must be saved in today's verification run",
  );
  const bytes = await fs.readFile(actual),
    fresh = JSON.parse(bytes.toString('utf8'));
  const baseline = JSON.parse(
    await fs.readFile(
      'data/source-samples/crawler/new-airlines-20261014/jta-browser-schedule.json',
      'utf8',
    ),
  );
  validateBrowserJta(fresh, baseline);
  const snapshotBytes = await fs.readFile('src/server/data/jta-flights.json');
  const imported = JSON.parse(
    await fs.readFile(
      'data/flight-updates/integrate-jta-jetstar-20261014/progress.json',
      'utf8',
    ),
  );
  assert.equal(
    sha(snapshotBytes),
    imported.steps.find(
      (s: any) => s.file === 'src/server/data/jta-flights.json',
    )?.sha256,
    'JTA catalogue changed; replay changed schedule before browser verification',
  );
  const snapshot = JSON.parse(
    snapshotBytes.toString('utf8'),
  ) as CollectedSnapshot;
  const rows = snapshot.records.filter(
    (r) => r.date >= taipeiDate() && r.date <= '2026-12-31',
  );
  assert.ok(rows.length);
  const group = buildGroups(rows)[0];
  assert.equal(group.kind, 'collected_jta');
  const lock = await fs.open(path.join(base, 'run.lock'), 'wx');
  try {
    const ledger = JSON.parse(
      await fs.readFile(path.join(base, 'latest.json'), 'utf8'),
    ) as VerificationLedger;
    const outcome = compareObservation(
      rows,
      rows.map((r) => ({
        number: r.number,
        date: r.date,
        airport: r.airport!,
        departure: r.departure,
        arrival: r.arrival,
        minutes: r.minutes,
      })),
      fresh.capturedAt,
      actual,
      ledger,
    );
    ledger.updatedAt = new Date().toISOString();
    await atomic(path.join(base, 'latest.json'), ledger);
    const job = JSON.parse(
      await fs.readFile(path.join(root, 'progress.json'), 'utf8'),
    );
    await fs.writeFile(
      path.join(root, group.id + '.before-browser-' + randomUUID() + '.json'),
      JSON.stringify(job.completed[group.id], null, 2),
      { flag: 'wx' },
    );
    job.completed[group.id] = {
      state: 'compared',
      kind: group.kind,
      records: rows.length,
      verified: rows.length,
      changed: 0,
      notListed: 0,
      added: 0,
      method: fresh.method,
      evidenceFile: actual,
      sha256: sha(bytes),
    };
    const all = Object.values(job.completed) as any[];
    job.summary.verifiedRows = all.reduce((n, r) => n + (r.verified || 0), 0);
    job.summary.pendingRows = all
      .filter((r) => r.state !== 'compared')
      .reduce((n, r) => n + r.records, 0);
    job.state =
      all.length !== job.totalGroups
        ? 'batch_saved'
        : job.summary.pendingRows ||
            job.summary.changedRows ||
            job.summary.notListedRows
          ? 'completed_with_pending'
          : 'verified';
    job.savedAt = ledger.updatedAt;
    await atomic(path.join(root, 'progress.json'), job);
    await atomic(path.join(root, group.id + '.browser-comparison.json'), {
      at: fresh.capturedAt,
      evidenceFile: actual,
      sha256: sha(bytes),
      outcome,
      scope: 'saved_rows_only',
    });
    console.log(
      JSON.stringify({
        state: 'browser_source_verified',
        verified: outcome.verified,
      }),
    );
  } finally {
    await lock.close();
    await fs.unlink(path.join(base, 'run.lock'));
  }
}
if (process.argv.includes('--apply'))
  applyBrowserJta(process.argv[process.argv.indexOf('--apply') + 1]).catch(
    (e) => {
      console.error(e.message);
      process.exitCode = 1;
    },
  );
