import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  normalizeCollected,
  type SavedFlight,
} from '../../src/server/providers/collected';
import { arrivalAirport } from '../../src/features/flights/destinations';
import {
  verificationKey,
  verificationFingerprint,
} from '../../src/server/services/timetable-verification';
import { evaTableObservations } from './eva-public-table';
import { buildGroups, sha } from './sources';
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
  const args = process.argv.slice(2),
    python = args[args.indexOf('--python') + 1];
  assert.ok(args.includes('--python'));
  const research = 'data/source-samples/crawler/eva-recheck-2026-10-14',
    base = 'data/automatic-verification',
    daily = `${base}/runs/2026-10-14`,
    target = 'src/server/data/eva-flights.json',
    plan = await read(research + '/progress.json'),
    snapshot = await read(target);
  const route = plan.routes.find((r: any) => r.airport === 'CNX'),
    candidate = route.records.find(
      (r: any) => r.number === 'BR1257' && r.date === '2026-11-24',
    );
  assert.ok(candidate);
  assert.ok(
    !snapshot.records.some(
      (r: SavedFlight) => verificationKey(r) === verificationKey(candidate),
    ),
    'Already imported; refuse duplicate',
  );
  const file = research + '/' + candidate.evidenceFile,
    bytes = await fs.readFile(file),
    receipt = await read(file + '.receipt.json');
  assert.equal(receipt.httpStatus, 200);
  assert.equal(sha(bytes), receipt.sha256);
  const page = JSON.parse(
    execFileSync(
      python,
      ['-X', 'utf8', 'scripts/crawler/fetch-eva-form.py', '--parse-file', file],
      {
        encoding: 'utf8',
        timeout: 20000,
        maxBuffer: 4_000_000,
        windowsHide: true,
      },
    ),
  );
  const observation = evaTableObservations(
    page.rows,
    'CNX',
    plan.from,
    plan.through,
  ).observations.find(
    (r) => r.number === candidate.number && r.date === candidate.date,
  );
  assert.ok(observation);
  assert.equal(observation.departure, '2026-11-24T09:10:00+08:00');
  assert.equal(observation.arrival, '2026-11-24T12:15:00+07:00');
  assert.equal(observation.minutes, 245);
  const airport = arrivalAirport('CNX')!;
  assert.equal(airport.countryCode, 'TH');
  const row: SavedFlight = {
    ...observation,
    airline: '長榮航空',
    arrivalTimeZone: 'Asia/Bangkok',
    candidateAirport: null,
    destination: airport.city,
    destinationEnglish: 'Chiang Mai',
    countryCode: 'TH',
    terminal: null,
    arrivalTerminal: null,
    aircraft: null,
    kind: 'collected_eva',
    label: '長榮官方預定班表',
    url: plan.sourceUrl,
    fetchedAt: receipt.observedAt,
    operatingAirline: '長榮航空',
    operatingNumber: observation.number,
    codeshare: false,
    page: null,
    evidence: { file, sha256: receipt.sha256, sourceUrl: receipt.url },
  };
  normalizeCollected(row);
  const lock = await fs.open(base + '/run.lock', 'wx');
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  try {
    const job = await read(daily + '/progress.json'),
      ledger = await read(base + '/latest.json');
    for (const [file, digest] of Object.entries(job.originals))
      assert.equal(sha(await fs.readFile(file)), digest);
    const run = `data/flight-updates/eva-addition-${Date.now()}`;
    await fs.mkdir(run, { recursive: true });
    for (const [name, file] of [
      ['eva', target],
      ['progress', daily + '/progress.json'],
      ['ledger', base + '/latest.json'],
    ])
      await fs.writeFile(
        `${run}/before-${name}.json`,
        await fs.readFile(file),
        { flag: 'wx' },
      );
    await atomic(run + '/difference.json', {
      state: 'validated_before_import',
      row,
      sourceReceipt: file + '.receipt.json',
      reason:
        'New explicitly dated own-operated direct departure; unknown aircraft and terminals remain null',
    });
    await fs.writeFile(run + '/source.body', bytes, { flag: 'wx' });
    await atomic(run + '/source.receipt.json', {
      url: receipt.url,
      status: 200,
      method: 'POST',
      sha256: receipt.sha256,
      fetchedAt: receipt.observedAt,
      originalReceipt: file + '.receipt.json',
    });
    const records = [...snapshot.records, row].sort(
      (a: SavedFlight, b: SavedFlight) =>
        a.departure.localeCompare(b.departure) ||
        a.number.localeCompare(b.number),
    );
    for (const r of snapshot.records)
      assert.deepEqual(
        records.find(
          (n: SavedFlight) => verificationKey(n) === verificationKey(r),
        ),
        r,
      );
    await atomic(target, {
      ...snapshot,
      records,
      coverage: snapshot.coverage.map((c: any) => ({
        ...c,
        records: c.records + 1,
      })),
    });
    const all: SavedFlight[] = [];
    for (const brand of [
      'eva',
      'peach',
      'tigerair',
      'starlux',
      'jeju',
      'vietnam',
      'jta',
      'jetstar',
    ])
      all.push(
        ...(await read(`src/server/data/${brand}-flights.json`)).records.filter(
          (r: SavedFlight) => r.date >= job.from && r.date <= job.through,
        ),
      );
    const groups = buildGroups(all);
    assert.equal(groups.length, job.groupIDs.length + 1);
    assert.ok(
      job.groupIDs.every((id: string) => groups.some((g) => g.id === id)),
    );
    const id = buildGroups([row])[0].id;
    assert.ok(!job.completed[id]);
    job.groupIDs = groups.map((g) => g.id);
    job.completed[id] = {
      state: 'compared',
      kind: 'collected_eva',
      records: 1,
      verified: 1,
      changed: 0,
      notListed: 0,
      added: 0,
      importEvidence: run,
    };
    job.records++;
    job.totalGroups++;
    job.summary.completedGroups++;
    job.summary.totalGroups++;
    job.summary.verifiedRows++;
    job.summary.importedAdditionalRows++;
    ledger.entries[verificationKey(row)] = {
      state: 'verified',
      fingerprint: verificationFingerprint(row),
      attemptedAt: receipt.observedAt,
      verifiedAt: receipt.observedAt,
      evidenceFile: path.resolve(run + '/source.body'),
    };
    ledger.updatedAt = new Date().toISOString();
    await atomic(base + '/latest.json', ledger);
    job.catalogueTransitions.push({
      file: target,
      before: job.originals[target],
      after: sha(await fs.readFile(target)),
      added: 1,
      evidence: run,
      at: ledger.updatedAt,
    });
    job.originals[target] = sha(await fs.readFile(target));
    job.savedAt = ledger.updatedAt;
    await atomic(daily + '/progress.json', job);
    await atomic(run + '/progress.json', {
      state: 'imported_verified',
      added: 1,
      existingEvaRecordsUnchanged: snapshot.records.length,
      key: verificationKey(row),
      unknownFields: ['aircraft', 'terminal', 'arrivalTerminal'],
    });
    console.log(
      JSON.stringify({
        added: verificationKey(row),
        records: records.length,
        run,
      }),
    );
  } finally {
    await lock.close();
    await fs.unlink(base + '/run.lock');
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
