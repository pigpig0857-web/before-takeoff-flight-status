import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  normalizeCollected,
  type SavedFlight,
  type CollectedSnapshot,
} from '../../src/server/providers/collected';
import {
  buildGroups,
  sourceVerifier,
  sha,
} from '../automatic-verification/sources';
import { compareObservation } from '../automatic-verification/compare';
import { verificationKey } from '../../src/server/services/timetable-verification';
import { taipeiDate } from '../../src/lib/time';
const research = 'data/source-samples/crawler/khh-jeju-20261016';
const base = 'data/automatic-verification',
  daily = base + '/runs/2026-10-16';
const target = 'src/server/data/kaohsiung-jeju-flights.json';
const read = async (p: string) =>
  JSON.parse((await fs.readFile(p, 'utf8')).replace(/^\uFEFF/, ''));
async function atomic(p: string, value: unknown) {
  const tmp = p + '.' + randomUUID() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
  await fs.rename(tmp, p);
}
async function main() {
  assert.equal(taipeiDate(), '2026-10-16');
  const audit = await read(research + '/audit.json'),
    candidate = await read(research + '/candidate-flights.json');
  assert.equal(audit.state, 'passed');
  assert.equal(audit.records, 110);
  assert.equal(audit.checkedDateAirportCells, 154);
  assert.ok(audit.officialDirectDestinationInventoryComplete);
  const records = candidate.records as SavedFlight[];
  assert.equal(records.length, 110);
  assert.equal(new Set(records.map(verificationKey)).size, 110);
  records.forEach(normalizeCollected);
  const proofHashes = new Map<string, string>();
  for (const r of records) {
    const proof = r.evidence!;
    const receipt = await read(proof.file.replace(/\.body$/, '.receipt.json'));
    if (!proofHashes.has(proof.file))
      proofHashes.set(proof.file, sha(await fs.readFile(proof.file)));
    assert.equal(proofHashes.get(proof.file), proof.sha256);
    assert.equal(proof.sha256, receipt.sha256);
    assert.equal(receipt.status, 200);
    assert.equal(receipt.url, proof.sourceUrl);
    assert.equal(receipt.fetchedAt, r.fetchedAt);
  }
  try {
    await fs.access(target);
    throw new Error('Refuse duplicate import');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const lock = await fs.open(base + '/run.lock', 'wx');
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    const job = await read(daily + '/progress.json'),
      ledger = await read(base + '/latest.json');
    assert.equal(job.state, 'completed_with_pending');
    const originals = structuredClone(job.originals),
      prior = structuredClone(ledger.entries);
    for (const [file, hash] of Object.entries(originals))
      assert.equal(sha(await fs.readFile(file)), hash);
    const run = `data/flight-updates/khh-jeju-import-${Date.now()}`;
    await fs.mkdir(run, { recursive: true });
    for (const [name, file] of [
      ['progress', daily + '/progress.json'],
      ['ledger', base + '/latest.json'],
      ['completion', base + '/COMPLETION_STATUS.json'],
    ])
      await fs.writeFile(
        `${run}/before-${name}.json`,
        await fs.readFile(file),
        { flag: 'wx' },
      );
    await atomic(run + '/progress.json', {
      state: 'validated_before_import',
      added: 110,
      originals,
    });
    const old: SavedFlight[] = [];
    for (const brand of [
      'eva',
      'peach',
      'tigerair',
      'starlux',
      'jeju',
      'vietnam',
      'jta',
      'jetstar',
      'philippine',
      'kaohsiung',
      'kaohsiung-peach',
      'kaohsiung-jetstar',
    ])
      old.push(
        ...(await read(`src/server/data/${brand}-flights.json`)).records.filter(
          (r: SavedFlight) => r.date >= job.from && r.date <= job.through,
        ),
      );
    assert.deepEqual(
      buildGroups(old, { evaPublicForm: true, from: job.from }).map(
        (g) => g.id,
      ),
      job.groupIDs,
    );
    const groups = buildGroups([...old, ...records], {
      evaPublicForm: true,
      from: job.from,
    });
    const extra = groups.filter((g) => !job.groupIDs.includes(g.id));
    assert.equal(extra.length, 24);
    const known = new Set([...old, ...records].map(verificationKey));
    for (const group of extra) {
      const r = group.records[0],
        source = r.evidence!.file,
        receipt = await read(source.replace(/\.body$/, '.receipt.json'));
      assert.ok(
        group.records.every(
          (r) => r.origin === 'KHH' && r.evidence!.file === source,
        ),
      );
      const stem = `${daily}/${group.id}`;
      const verify = sourceVerifier(
        '',
        async (url, _id, options) => {
          if (url.endsWith('viewScheduleInfo.do'))
            return {
              body: await fs.readFile(
                'data/source-samples/crawler/khh-airline-research-20261016/jeju-session.body',
              ),
              file: 'data/source-samples/crawler/khh-airline-research-20261016/jeju-session.body',
              url,
              at: receipt.fetchedAt,
            };
          assert.equal(url, receipt.url);
          assert.equal(options?.body?.get('depStn'), 'KHH');
          assert.equal(options?.body?.get('arrStn'), group.airport);
          assert.equal(
            options?.body?.get('startDate'),
            group.queryDate!.replaceAll('-', ''),
          );
          return {
            body: await fs.readFile(source),
            file: path.resolve(stem + '.body'),
            url,
            at: receipt.fetchedAt,
          };
        },
        job.from,
      );
      const observation = await verify(group);
      group.records.forEach((r) =>
        assert.ok(!ledger.entries[verificationKey(r)]),
      );
      const compared = compareObservation(
        group.records,
        observation.rows,
        receipt.fetchedAt,
        path.resolve(stem + '.body'),
        ledger,
        known,
      );
      assert.equal(compared.verified, group.records.length);
      assert.equal(compared.changed, 0);
      assert.equal(compared.not_listed, 0);
      assert.equal(compared.added.length, 0);
      await fs.writeFile(stem + '.body', await fs.readFile(source), {
        flag: 'wx',
      });
      await fs.writeFile(
        stem + '.receipt.json',
        JSON.stringify({ ...receipt, originalEvidence: source }, null, 2),
        { flag: 'wx' },
      );
      await atomic(stem + '.comparison.json', {
        kind: group.kind,
        origin: 'KHH',
        scope: observation.scope,
        at: receipt.fetchedAt,
        compared,
        observations: observation.rows,
        evidenceFile: path.resolve(stem + '.body'),
      });
      job.completed[group.id] = {
        state: 'compared',
        kind: group.kind,
        origin: 'KHH',
        records: group.records.length,
        verified: group.records.length,
        changed: 0,
        notListed: 0,
        added: 0,
        importEvidence: run,
      };
      await atomic(run + '/progress.json', {
        state: 'source_groups_validated',
        added: 110,
        originals,
        completedNewGroups: extra.filter((g) => job.completed[g.id]).length,
        totalNewGroups: extra.length,
      });
    }
    const snapshot: CollectedSnapshot = {
      version: 1,
      importedAt: new Date().toISOString(),
      records,
      coverage: [
        {
          kind: 'collected_jeju',
          label: '濟州航空高雄出發官方班表',
          url: records[0].url,
          fetchedAt: records.map((r) => r.fetchedAt).sort()[0],
          description:
            '高雄出發金浦、釜山官方公布預定班表；已查核 2026/10/16～12/31 日期範圍，未列班次不推算為每日航班。非即時動態。',
          dates: [...new Set(records.map((r) => r.date))].sort(),
          records: records.length,
        },
      ],
    };
    for (const [key, entry] of Object.entries(prior))
      assert.deepEqual(ledger.entries[key], entry);
    for (const [file, hash] of Object.entries(originals))
      assert.equal(sha(await fs.readFile(file)), hash);
    await fs.writeFile(target, JSON.stringify(snapshot, null, 2) + '\n', {
      flag: 'wx',
    });
    job.originals[target] = sha(await fs.readFile(target));
    job.catalogueTransitions = [
      ...(job.catalogueTransitions || []),
      {
        file: target,
        before: null,
        after: job.originals[target],
        added: 110,
        origin: 'KHH',
        evidence: run,
        at: snapshot.importedAt,
      },
    ];
    job.groupIDs = groups.map((g) => g.id);
    job.records += 110;
    job.totalGroups = groups.length;
    job.summary.completedGroups += extra.length;
    job.summary.totalGroups = groups.length;
    job.summary.verifiedRows += 110;
    job.summary.importedAdditionalRows =
      (job.summary.importedAdditionalRows || 0) + 110;
    job.summary.originalFilesUnchanged = Object.keys(job.originals).length;
    ledger.updatedAt = job.savedAt = new Date().toISOString();
    await atomic(base + '/latest.json', ledger);
    await atomic(daily + '/progress.json', job);
    await atomic(run + '/progress.json', {
      state: 'imported_pending_website_tests',
      added: 110,
      currentKhhTotal: 904,
      originals,
      oldLedgerEntriesUnchanged: Object.keys(prior).length,
      newGroups: extra.map((g) => g.id),
      networkRequests: 0,
    });
    console.log(
      JSON.stringify({
        run,
        added: 110,
        currentKhhTotal: 904,
        newGroups: extra.length,
      }),
    );
  } finally {
    await lock.close();
    await fs.unlink(base + '/run.lock');
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
