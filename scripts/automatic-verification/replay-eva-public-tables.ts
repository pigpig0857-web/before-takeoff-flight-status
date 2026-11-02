/** Offline promotion of fresh, hash-checked official tables. Never requests a source. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { SavedFlight } from '../../src/server/providers/collected';
import {
  verificationKey,
  type VerificationLedger,
} from '../../src/server/services/timetable-verification';
import { buildGroups, sha } from './sources';
import { compareObservation, type Observation } from './compare';
import { evaTableObservations } from './eva-public-table';
const args = process.argv.slice(2),
  arg = (key: string) =>
    args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
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
  const research = path.resolve(arg('--research')!),
    python = arg('--python');
  assert.ok(python);
  assert.ok(
    research.startsWith(path.resolve('data/source-samples/crawler') + path.sep),
  );
  const plan = await read(path.join(research, 'progress.json'));
  const base = path.resolve('data/automatic-verification'),
    daily = path.join(base, 'runs', plan.from),
    root = path.join(base, 'recovery', `eva-form-${plan.from}`);
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
    const snapshot = await read('src/server/data/eva-flights.json'),
      saved: SavedFlight[] = snapshot.records.filter(
        (r: SavedFlight) => r.date >= plan.from && r.date <= plan.through,
      );
    const known = new Set(saved.map(verificationKey));
    let progress: any;
    try {
      progress = await read(path.join(root, 'progress.json'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (!progress) {
      progress = {
        version: 1,
        state: 'running',
        research,
        from: plan.from,
        through: plan.through,
        completed: {},
        originals: job.originals,
      };
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
    const checkpoint = async () => {
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
      await atomic(path.join(base, 'latest.json'), ledger);
      await atomic(path.join(daily, 'progress.json'), job);
      progress.savedAt = job.savedAt;
      await atomic(path.join(root, 'progress.json'), progress);
    };
    let verified = 0,
      changed = 0,
      notListed = 0;
    for (const route of plan.routes) {
      const groups = buildGroups(
        saved.filter((r) => r.airport === route.airport),
      );
      if (groups.every((g) => progress.completed[g.id])) continue;
      const evidenceByDate = new Map<
        string,
        { rows: Observation[]; at: string; file: string }
      >();
      for (const observation of route.observations.filter(
        (o: any) => o.validated,
      )) {
        assert.equal(path.basename(observation.file), observation.file);
        const file = path.join(research, observation.file),
          raw = await fs.readFile(file),
          receipt = await read(file + '.receipt.json');
        assert.equal(receipt.httpStatus, 200);
        assert.equal(sha(raw), receipt.sha256);
        assert.equal(receipt.observedAt, observation.observedAt);
        const parsed = JSON.parse(
          execFileSync(
            python,
            [
              '-X',
              'utf8',
              'scripts/crawler/fetch-eva-form.py',
              '--parse-file',
              file,
            ],
            {
              encoding: 'utf8',
              timeout: 20000,
              maxBuffer: 4_000_000,
              windowsHide: true,
            },
          ),
        );
        assert.ok(
          /<img[^>]+src="https:\/\/booking\.evaair\.com\/flyeva\/content\/images\/b2c\/icon_rwd\/BR\.png"[^>]+alt="EVA AIR"/.test(
            raw.toString('utf8'),
          ),
        );
        const result = evaTableObservations(
          parsed.rows,
          route.airport,
          plan.from,
          plan.through,
        );
        assert.deepEqual(
          result.dates.filter(
            (d: string) => d >= plan.from && d <= plan.through,
          ),
          observation.dates,
        );
        // Normalize the immutable receipt alongside the body for the website audit.
        const target = path.join(root, path.basename(file) + '.body');
        try {
          assert.equal(sha(await fs.readFile(target)), receipt.sha256);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          await fs.writeFile(target, raw, { flag: 'wx' });
          await atomic(target.replace(/\.body$/, '.receipt.json'), {
            url: receipt.url,
            status: 200,
            method: 'POST',
            fetchedAt: receipt.observedAt,
            sha256: receipt.sha256,
            originalReceipt: file + '.receipt.json',
            queryDate: observation.queryDate,
            airport: route.airport,
          });
        }
        for (const date of observation.dates)
          evidenceByDate.set(date, {
            rows: result.observations.filter((r) => r.date === date),
            at: receipt.observedAt,
            file: target,
          });
      }
      for (const group of groups) {
        if (
          progress.completed[group.id] ||
          !group.records.every((r) => evidenceByDate.has(r.date))
        )
          continue;
        if (
          group.records.every(
            (r) => ledger.entries[verificationKey(r)]?.state === 'verified',
          )
        ) {
          progress.completed[group.id] = job.completed[group.id];
          continue;
        }
        assert.ok(
          group.records.every(
            (r) => ledger.entries[verificationKey(r)]?.state !== 'verified',
          ),
          'Do not repeat verified rows',
        );
        const outcomes: any[] = [],
          additions: Observation[] = [];
        for (const row of group.records) {
          const e = evidenceByDate.get(row.date)!;
          const compared = compareObservation(
            [row],
            e.rows,
            e.at,
            e.file,
            ledger,
            known,
          );
          outcomes.push({
            key: verificationKey(row),
            compared,
            evidenceFile: e.file,
            at: e.at,
            observations: e.rows,
          });
          additions.push(...compared.added);
        }
        const summary = {
          state: 'compared',
          kind: 'collected_eva',
          records: group.records.length,
          verified: outcomes.reduce((n, o) => n + o.compared.verified, 0),
          changed: outcomes.reduce((n, o) => n + o.compared.changed, 0),
          notListed: outcomes.reduce((n, o) => n + o.compared.not_listed, 0),
          added: 0,
          recoveryEvidence: root,
        };
        await atomic(path.join(root, group.id + '.comparison.json'), {
          priorOutcome: job.completed[group.id],
          outcomes,
          additionalCandidates: additions,
        });
        progress.completed[group.id] = summary;
        job.completed[group.id] = summary;
        verified += summary.verified;
        changed += summary.changed;
        notListed += summary.notListed;
      }
      await checkpoint();
      console.log(
        JSON.stringify({
          airport: route.airport,
          newVerified: verified,
          newChanged: changed,
          newNotListed: notListed,
          savedGroups: Object.keys(progress.completed).length,
        }),
      );
    }
    for (const [file, digest] of Object.entries(job.originals))
      assert.equal(sha(await fs.readFile(file)), digest);
    progress.originals = job.originals;
    progress.catalogueTransitions = job.catalogueTransitions || [];
    progress.state =
      Object.keys(progress.completed).length === buildGroups(saved).length
        ? 'completed'
        : 'batch_saved';
    if (progress.state === 'completed') {
      job.recoveredSources ??= [];
      if (!job.recoveredSources.some((r: any) => r.evidence === root))
        job.recoveredSources.push({
          host: 'booking.evaair.com',
          at: new Date().toISOString(),
          priorBlock: job.blockedHosts['booking.evaair.com'],
          reason:
            'Fresh official public form tables replace expired encrypted detail links; details retain original provenance',
          evidence: root,
        });
      delete job.blockedHosts['booking.evaair.com'];
    }
    await checkpoint();
    console.log(
      JSON.stringify({
        state: progress.state,
        newVerified: verified,
        newChanged: changed,
        newNotListed: notListed,
        cumulativeVerified: job.summary.verifiedRows,
        pending: job.summary.pendingRows,
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
