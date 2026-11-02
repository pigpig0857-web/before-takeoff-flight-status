import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseStarluxWeek } from '../../src/server/providers/experimental/starlux-timetable';
import {
  normalizeCollected,
  type SavedFlight,
  type CollectedSnapshot,
} from '../../src/server/providers/collected';
import {
  verificationKey,
  verificationFingerprint,
  type VerificationLedger,
} from '../../src/server/services/timetable-verification';
import { buildGroups, sha } from './sources';
const base = 'data/automatic-verification',
  daily = `${base}/runs/2026-10-14`;
const read = async (file: string) =>
  JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const atomic = async (file: string, value: any) => {
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
  await fs.rename(tmp, file);
};
async function main() {
  const audit = await read(`${daily}/audit.json`);
  const candidate = audit.additionalSourceRecords;
  assert.equal(candidate.length, 3);
  const target = 'src/server/data/starlux-flights.json',
    beforeBytes = await fs.readFile(target);
  const before = JSON.parse(beforeBytes.toString('utf8')) as CollectedSnapshot;
  const oldKeys = new Set(before.records.map(verificationKey));
  assert.ok(
    candidate.every((r: any) => !oldKeys.has(verificationKey(r))),
    'Already integrated; refuse duplicate import',
  );
  const additions: SavedFlight[] = [];
  for (const r of candidate) {
    const bytes = await fs.readFile(r.evidenceFile),
      receipt = await read(r.evidenceFile.replace(/\.body$/, '.receipt.json'));
    assert.equal(sha(bytes), r.sha256);
    assert.equal(receipt.status, 200);
    assert.equal(receipt.url, r.sourceUrl);
    const url = new URL(receipt.url);
    assert.equal(url.origin, 'https://ecapi.starlux-airlines.com');
    const result = parseStarluxWeek(JSON.parse(bytes.toString('utf8')), {
      destination: 'CGK',
      date: url.searchParams.get('date')!,
      from: '2026-10-14',
      through: '2026-12-31',
    });
    assert.equal(result.pending.length, 0);
    assert.equal(result.conflicts.length, 0);
    const match = result.flights.find(
      (f) => f.publishedFlightNumber === r.number && f.date === r.date,
    )!;
    assert.ok(match);
    assert.equal(match.approvalPending, false);
    assert.equal(match.operatingAirlineCode, 'JX');
    assert.equal(Date.parse(match.scheduledDeparture), Date.parse(r.departure));
    assert.equal(Date.parse(match.scheduledArrival), Date.parse(r.arrival));
    const record: SavedFlight = {
      number: r.number,
      airline: '星宇航空',
      date: r.date,
      departure: r.departure,
      arrival: r.arrival,
      arrivalTimeZone: 'Asia/Jakarta',
      airport: 'CGK',
      candidateAirport: null,
      destination: '雅加達',
      destinationEnglish: 'Jakarta',
      countryCode: 'ID',
      terminal: match.departureTerminal ? `T${match.departureTerminal}` : null,
      arrivalTerminal: match.arrivalTerminal,
      aircraft: match.aircraft,
      minutes: match.durationMinutes,
      kind: 'collected_starlux',
      label: '星宇航空官方預定班表',
      url: `https://www.starlux-airlines.com/zh-TW/timetable/search-result?depAirport=TPE&arrAirport=CGK&date=${r.date}`,
      fetchedAt: receipt.fetchedAt,
      operatingAirline: '星宇航空',
      operatingNumber: r.number,
      codeshare: false,
      page: null,
      evidence: {
        file: path
          .relative(process.cwd(), r.evidenceFile)
          .replaceAll('\\', '/'),
        sha256: r.sha256,
        sourceUrl: receipt.url,
        rowIndex: match.sourceRow,
      },
    };
    normalizeCollected(record);
    additions.push(record);
  }
  const lock = await fs.open(`${base}/run.lock`, 'wx');
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  try {
    const job = await read(`${daily}/progress.json`),
      ledger = (await read(`${base}/latest.json`)) as VerificationLedger;
    assert.equal(sha(beforeBytes), job.originals[target]);
    for (const [file, digest] of Object.entries(job.originals))
      assert.equal(sha(await fs.readFile(file)), digest);
    const run = `data/flight-updates/starlux-additions-${Date.now()}`;
    await fs.mkdir(run, { recursive: true });
    for (const [name, file] of [
      ['starlux', target],
      ['progress', `${daily}/progress.json`],
      ['ledger', `${base}/latest.json`],
    ])
      await fs.writeFile(
        `${run}/before-${name}.json`,
        await fs.readFile(file),
        { flag: 'wx' },
      );
    const progress = {
      state: 'validated',
      beforeHash: sha(beforeBytes),
      additions: additions.map(verificationKey),
      previousVerified: job.summary.verifiedRows,
    };
    await atomic(`${run}/progress.json`, progress);
    const next: CollectedSnapshot = {
      ...before,
      records: [...before.records, ...additions].sort(
        (a, b) =>
          a.departure.localeCompare(b.departure) ||
          a.number.localeCompare(b.number),
      ),
      coverage: before.coverage.map((c) => ({ ...c, records: c.records + 3 })),
    };
    for (const r of before.records)
      assert.deepEqual(
        next.records.find((n) => verificationKey(n) === verificationKey(r)),
        r,
        'An existing record changed',
      );
    assert.equal(
      new Set(next.records.map(verificationKey)).size,
      next.records.length,
    );
    const groupIDs = buildGroups(
      next.records.filter((r) => r.date >= '2026-10-14'),
    ).map((g) => g.id);
    assert.equal(groupIDs.length, 396);
    await atomic(target, next);
    for (const r of additions) {
      ledger.entries[verificationKey(r)] = {
        fingerprint: verificationFingerprint(r),
        state: 'verified',
        attemptedAt: r.fetchedAt,
        verifiedAt: r.fetchedAt,
        evidenceFile: path.resolve(r.evidence!.file),
      };
      const id = buildGroups([r])[0].id;
      assert.equal(job.completed[id].state, 'compared');
      job.completed[id].records++;
      job.completed[id].verified++;
    }
    ledger.updatedAt = new Date().toISOString();
    await atomic(`${base}/latest.json`, ledger);
    job.catalogueTransitions ??= [];
    job.catalogueTransitions.push({
      file: target,
      before: sha(beforeBytes),
      after: sha(await fs.readFile(target)),
      added: 3,
      evidence: run,
      at: ledger.updatedAt,
    });
    job.originals[target] = sha(await fs.readFile(target));
    job.records += 3;
    job.summary.verifiedRows += 3;
    job.summary.importedAdditionalRows = 3;
    job.savedAt = ledger.updatedAt;
    await atomic(`${daily}/progress.json`, job);
    for (const [file, digest] of Object.entries(job.originals))
      assert.equal(sha(await fs.readFile(file)), digest);
    progress.state = 'imported_verified';
    await atomic(`${run}/progress.json`, {
      ...progress,
      afterHash: job.originals[target],
      verified: job.summary.verifiedRows,
      unchangedExistingStarRecords: before.records.length,
      otherFilesUnchanged: 10,
    });
    console.log(
      JSON.stringify({
        run,
        added: 3,
        starluxRecords: next.records.length,
        activeStarlux: 2921,
        verified: job.summary.verifiedRows,
        otherFilesUnchanged: 10,
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
