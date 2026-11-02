import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  normalizeCollected,
  type SavedFlight,
} from '../../src/server/providers/collected';
import {
  verificationKey,
  verificationFingerprint,
} from '../../src/server/services/timetable-verification';
import { buildGroups, sha, sourceVerifier } from './sources';
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
  const base = 'data/automatic-verification',
    daily = `${base}/runs/2026-10-14`,
    proof = `${base}/recovery/vietnam-2026-10-14-system-ca/2bd2ba45a34dca3eb1c0bda2`,
    target = 'src/server/data/vietnam-flights.json';
  const lock = await fs.open(`${base}/run.lock`, 'wx');
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  try {
    const job = await read(`${daily}/progress.json`),
      ledger = await read(`${base}/latest.json`),
      snapshot = await read(target);
    for (const [file, digest] of Object.entries(job.originals))
      assert.equal(sha(await fs.readFile(file)), digest);
    const old: SavedFlight = snapshot.records.find(
      (r: SavedFlight) =>
        r.date === '2026-10-25' && r.number === 'VN571' && r.airport === 'SGN',
    );
    assert.ok(old);
    assert.equal(old.arrival, '2026-10-25T10:15:00+07:00');
    assert.equal(old.minutes, 210);
    const comparison = await read(proof + '.comparison.json'),
      receipt = await read(proof + '.receipt.json'),
      body = await fs.readFile(proof + '.body');
    assert.equal(receipt.status, 200);
    assert.equal(sha(body), receipt.sha256);
    assert.equal(comparison.compared.changed, 1);
    const group = buildGroups([old])[0],
      verify = sourceVerifier(
        'unused',
        async (url) => {
          assert.equal(url, receipt.url);
          return {
            body,
            url,
            at: receipt.fetchedAt,
            file: path.resolve(proof + '.body'),
          };
        },
        '2026-10-14',
      );
    const result = await verify(group);
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.rows, comparison.observations);
    const row = result.rows[0];
    assert.equal(row.departure, old.departure);
    assert.equal(row.arrival, '2026-10-25T10:20:00+07:00');
    assert.equal(row.minutes, 215);
    const raw = JSON.parse(body.toString('utf8')),
      items = raw.data.departureFlight.scheduleItems;
    const index = items.findIndex(
      (item: any) =>
        item.connectedFlights.length === 1 &&
        item.connectedFlights[0].flightInfo.marketingFlightNumber === '571' &&
        item.connectedFlights[0].flightInfo.departureLocation.dateTime.slice(
          0,
          10,
        ) === old.date,
    );
    assert.ok(index >= 0);
    const info = items[index].connectedFlights[0].flightInfo;
    assert.equal('T' + info.departureLocation.terminal, old.terminal);
    assert.equal(info.arrivalLocation.terminal, old.arrivalTerminal);
    assert.equal(
      raw.data.departureFlight.dictionaries.aircraft[info.airEquipmentCode],
      old.aircraft,
    );
    const next: SavedFlight = {
      ...old,
      arrival: row.arrival,
      minutes: row.minutes,
      fetchedAt: receipt.fetchedAt,
      ...(old.detail && {
        detail: { ...old.detail, fetchedAt: receipt.fetchedAt },
      }),
      evidence: {
        ...old.evidence!,
        file: proof + '.body',
        sha256: receipt.sha256,
        sourceUrl: receipt.url,
        rowIndex: index,
      },
    };
    normalizeCollected(next);
    const run = `data/flight-updates/vietnam-time-correction-${Date.now()}`;
    await fs.mkdir(run, { recursive: true });
    for (const [name, file] of [
      ['vietnam', target],
      ['ledger', `${base}/latest.json`],
      ['progress', `${daily}/progress.json`],
    ])
      await fs.writeFile(
        `${run}/before-${name}.json`,
        await fs.readFile(file),
        { flag: 'wx' },
      );
    await atomic(`${run}/difference.json`, {
      state: 'evidence_confirmed_before_correction',
      old,
      next,
      sourceReceipt: proof + '.receipt.json',
      at: new Date().toISOString(),
      reason:
        'Official explicit dated direct flight now arrives five minutes later',
    });
    const nextRecords = snapshot.records.map((r: SavedFlight) =>
      verificationKey(r) === verificationKey(old) ? next : r,
    );
    for (const r of snapshot.records.filter(
      (r: SavedFlight) => verificationKey(r) !== verificationKey(old),
    ))
      assert.deepEqual(
        nextRecords.find(
          (n: SavedFlight) => verificationKey(n) === verificationKey(r),
        ),
        r,
      );
    await atomic(target, { ...snapshot, records: nextRecords });
    ledger.entries[verificationKey(next)] = {
      state: 'verified',
      fingerprint: verificationFingerprint(next),
      attemptedAt: receipt.fetchedAt,
      verifiedAt: receipt.fetchedAt,
      evidenceFile: path.resolve(proof + '.body'),
    };
    ledger.updatedAt = new Date().toISOString();
    await atomic(`${base}/latest.json`, ledger);
    assert.equal(job.completed[group.id].changed, 1);
    job.completed[group.id].changed = 0;
    job.completed[group.id].verified = 1;
    job.completed[group.id].correctionEvidence = run;
    job.summary.changedRows--;
    job.summary.verifiedRows++;
    job.catalogueTransitions ??= [];
    job.catalogueTransitions.push({
      file: target,
      before: job.originals[target],
      after: sha(await fs.readFile(target)),
      corrected: 1,
      evidence: run,
      at: ledger.updatedAt,
    });
    job.originals[target] = sha(await fs.readFile(target));
    job.savedAt = ledger.updatedAt;
    await atomic(`${daily}/progress.json`, job);
    await atomic(`${run}/progress.json`, {
      state: 'corrected_verified',
      corrected: 1,
      otherVietnamRecordsUnchanged: snapshot.records.length - 1,
      evidence: proof + '.body',
      beforeFingerprint: verificationFingerprint(old),
      afterFingerprint: verificationFingerprint(next),
    });
    console.log(
      JSON.stringify({
        corrected: verificationKey(next),
        arrival: next.arrival,
        minutes: next.minutes,
        run,
        verified: job.summary.verifiedRows,
      }),
    );
  } finally {
    await lock.close();
    await fs.unlink(`${base}/run.lock`);
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
