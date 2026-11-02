/** Supplement unresolved records from exact future dates already explicitly present in fresh public responses. No network. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SavedFlight } from '../../src/server/providers/collected';
import {
  verificationKey,
  type VerificationLedger,
} from '../../src/server/services/timetable-verification';
import { buildGroups, sha } from './sources';
import { compareObservation, type Observation } from './compare';
import { vietnamPublicSegments } from './vietnam-public-segments';
const base = path.resolve('data/automatic-verification'),
  daily = path.join(base, 'runs', '2026-10-14'),
  source = path.join(base, 'recovery', 'vietnam-2026-10-14-system-ca'),
  root = path.join(base, 'recovery', 'vietnam-explicit-segments-2026-10-14');
const read = async (file: string) =>
  JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const atomic = async (file: string, value: unknown) => {
  const temp = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
  await fs.rename(temp, file);
};
async function main() {
  await fs.mkdir(root, { recursive: true });
  const lock = await fs.open(path.join(base, 'run.lock'), 'wx');
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  try {
    const job = await read(path.join(daily, 'progress.json')),
      ledger = (await read(
        path.join(base, 'latest.json'),
      )) as VerificationLedger;
    for (const [file, digest] of Object.entries(job.originals))
      assert.equal(sha(await fs.readFile(file)), digest);
    const snapshot = await read('src/server/data/vietnam-flights.json'),
      saved: SavedFlight[] = snapshot.records.filter(
        (r: SavedFlight) => r.date >= job.from && r.date <= job.through,
      ),
      known = new Set(saved.map(verificationKey));
    const files = (await fs.readdir(source))
      .filter((f) => f.endsWith('.body'))
      .map((f) => path.join(source, f));
    files.push(
      path.resolve(
        'data/source-samples/crawler/source-diagnosis-2026-10-14T08-01-55.839Z/vietnam.body',
      ),
    );
    const evidence = new Map<
      string,
      { row: Observation; file: string; at: string }
    >();
    for (const file of files) {
      const receipt = await read(file.replace(/\.body$/, '.receipt.json'));
      if (receipt.status !== 200) continue;
      const bytes = await fs.readFile(file);
      assert.equal(sha(bytes), receipt.sha256);
      const airport = new URL(receipt.url).searchParams.get(
        'destinationLocationCode',
      )!;
      for (const row of vietnamPublicSegments(
        JSON.parse(bytes.toString('utf8')),
        airport,
      )) {
        if (row.date < job.from || row.date > job.through) continue;
        const key = verificationKey(row),
          prior = evidence.get(key);
        if (prior)
          assert.deepEqual(
            prior.row,
            row,
            'Conflicting explicit source dates require review',
          );
        else evidence.set(key, { row, file, at: receipt.fetchedAt });
      }
    }
    let progress: any;
    try {
      progress = await read(path.join(root, 'progress.json'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (!progress) {
      progress = { state: 'running', completed: {}, sourceFiles: files.length };
      await fs.writeFile(
        path.join(root, 'before-progress.json'),
        JSON.stringify(job, null, 2),
        { flag: 'wx' },
      );
      await fs.writeFile(
        path.join(root, 'before-ledger.json'),
        JSON.stringify(ledger, null, 2),
        { flag: 'wx' },
      );
    }
    let count = 0;
    for (const group of buildGroups(saved)) {
      if (
        progress.completed[group.id] ||
        group.records.every(
          (r) => ledger.entries[verificationKey(r)]?.state === 'verified',
        )
      )
        continue;
      if (!group.records.every((r) => evidence.has(verificationKey(r))))
        continue;
      const outcomes: any[] = [];
      for (const row of group.records) {
        if (ledger.entries[verificationKey(row)]?.state === 'verified')
          continue;
        const e = evidence.get(verificationKey(row))!;
        const compared = compareObservation(
          [row],
          [e.row],
          e.at,
          e.file,
          ledger,
          known,
        );
        outcomes.push({
          key: verificationKey(row),
          observation: e.row,
          compared,
          evidenceFile: e.file,
          at: e.at,
        });
        count += compared.verified;
      }
      const states = group.records.map(
        (r) => ledger.entries[verificationKey(r)].state,
      );
      const outcome = {
        state: 'compared',
        kind: 'collected_vietnam',
        records: group.records.length,
        verified: states.filter((s) => s === 'verified').length,
        changed: states.filter((s) => s === 'changed').length,
        notListed: 0,
        added: 0,
        recoveryEvidence: root,
        scope: 'explicit_dated_segments_only_not_complete_daily_search',
      };
      await atomic(path.join(root, group.id + '.comparison.json'), {
        priorOutcome: job.completed[group.id],
        outcomes,
      });
      progress.completed[group.id] = outcome;
      job.completed[group.id] = outcome;
    }
    const stopped = await read(path.join(source, 'progress.json'));
    assert.ok(stopped.stopped);
    job.blockedHosts['integration-middleware-website.vietnamairlines.com'] = {
      ...stopped.stopped,
      file: path.join(source, '6a019316624b56e4677de7ee.pending.json'),
      meaning:
        'Latest HTTP 400 response reports upstream 503 Service Unavailable; no further source requests issued',
    };
    const outcomes = Object.values(job.completed) as any[];
    job.summary = {
      ...job.summary,
      verifiedRows: outcomes.reduce((n, r) => n + (r.verified || 0), 0),
      changedRows: outcomes.reduce((n, r) => n + (r.changed || 0), 0),
      notListedRows: outcomes.reduce((n, r) => n + (r.notListed || 0), 0),
      pendingRows: outcomes
        .filter((r) => r.state !== 'compared')
        .reduce((n, r) => n + r.records, 0),
    };
    job.savedAt = new Date().toISOString();
    ledger.updatedAt = job.savedAt;
    progress.state = 'saved_explicit_segments_source_still_unavailable';
    progress.newVerified = count;
    progress.savedAt = job.savedAt;
    for (const [file, digest] of Object.entries(job.originals))
      assert.equal(sha(await fs.readFile(file)), digest);
    await atomic(path.join(base, 'latest.json'), ledger);
    await atomic(path.join(daily, 'progress.json'), job);
    await atomic(path.join(root, 'progress.json'), progress);
    console.log(
      JSON.stringify({
        newVerified: count,
        totalVerified: job.summary.verifiedRows,
        pending: job.summary.pendingRows,
        changed: job.summary.changedRows,
        networkRequests: 0,
      }),
    );
  } finally {
    await lock.close();
    await fs.unlink(path.join(base, 'run.lock'));
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
