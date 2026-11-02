import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  normalizeCollected,
  type SavedFlight,
  type CollectedSnapshot,
} from '../../src/server/providers/collected';
import { buildGroups, sha } from '../automatic-verification/sources';
import { compareObservation } from '../automatic-verification/compare';
import {
  verificationKey,
  type VerificationLedger,
} from '../../src/server/services/timetable-verification';
import { philippinePDFs } from '../../src/server/providers/philippine-source';
import { taipeiDate } from '../../src/lib/time';

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
  // This import uses the reviewed, dated research checkpoint, never guessed rules.
  const root = 'data/source-samples/crawler/new-airlines-20261015';
  const base = 'data/automatic-verification';
  const daily = base + '/runs/2026-10-15';
  const target = 'src/server/data/philippine-flights.json';
  assert.equal(
    taipeiDate(),
    '2026-10-15',
    'Use an explicitly reviewed migration on another date',
  );
  const candidate = await read(
    root + '/verified-philippine/candidate-flights.json',
  );
  const audit = await read(root + '/verified-philippine/audit.json');
  assert.equal(candidate.records.length, 156);
  assert.equal(audit.records, 156);
  assert.equal(audit.duplicates, 0);
  assert.equal(audit.missingCoreFields, 0);
  assert.equal(audit.independentPDFExtractionAgrees, true);
  assert.equal(audit.relevantPagesVisuallyReviewed, true);
  assert.equal(candidate.integratedIntoWebsite, false);
  const records: SavedFlight[] = candidate.records.map((r: any) => ({
    number: r.number,
    airline: r.airline,
    date: r.date,
    departure: r.departure,
    arrival: r.arrival,
    arrivalTimeZone: r.arrivalTimeZone,
    airport: r.airport,
    candidateAirport: null,
    destination: r.destination,
    destinationEnglish: 'Manila',
    countryCode: r.countryCode,
    terminal: r.terminal,
    arrivalTerminal: r.arrivalTerminal,
    aircraft: r.aircraft,
    minutes: r.minutes,
    kind: 'collected_philippine',
    label: '菲律賓航空官方公布班表',
    url: r.url,
    fetchedAt: r.fetchedAt,
    operatingAirline: r.operatingAirline,
    operatingNumber: r.operatingNumber,
    codeshare: r.codeshare,
    page: r.evidence.page,
    sourcePublishedAt: r.sourcePublishedAt,
    sourceNotice: r.sourceNotice,
    evidence: {
      file: r.evidence.file,
      sha256: r.evidence.sha256,
      sourceUrl: r.url,
      rowIndex: r.evidence.rowIndex,
    },
  }));
  records.forEach(normalizeCollected);
  assert.equal(new Set(records.map(verificationKey)).size, 156);
  assert.equal(new Set(records.map((r) => r.date)).size, 78);
  const receipts = new Map<string, any>();
  for (const source of candidate.sources) {
    assert.ok(philippinePDFs.some((p) => p.url === source.url));
    const receiptFile = source.file.replace(/\.body$/, '.receipt.json');
    const receipt = await read(receiptFile);
    assert.equal(receipt.status, 200);
    assert.equal(receipt.url, source.url);
    assert.equal(receipt.fetchedAt, source.fetchedAt);
    assert.equal(sha(await fs.readFile(source.file)), source.sha256);
    assert.equal(receipt.sha256, source.sha256);
    assert.ok(
      records
        .filter((r) => r.url === source.url)
        .every((r) => r.evidence!.sha256 === source.sha256),
    );
    receipts.set(source.url, receipt);
  }
  const snapshot: CollectedSnapshot = {
    version: 1,
    importedAt: new Date().toISOString(),
    records,
    coverage: candidate.sources.map((s: any) => ({
      kind: 'collected_philippine',
      label: '菲律賓航空官方公布班表',
      url: s.url,
      fetchedAt: s.fetchedAt,
      description:
        '桃園→馬尼拉已公布季節班表，2026/10/15～12/31；非即時動態或訂位庫存，未提供機型與航廈。',
      dates: [
        ...new Set(records.filter((r) => r.url === s.url).map((r) => r.date)),
      ],
      records: records.filter((r) => r.url === s.url).length,
    })),
  };
  const lock = await fs.open(base + '/run.lock', 'wx');
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    try {
      await fs.access(target);
      throw new Error('Already imported; refuse overwrite');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const job = await read(daily + '/progress.json');
    const ledger: VerificationLedger = await read(base + '/latest.json');
    const beforeEntries = structuredClone(ledger.entries);
    for (const [file, digest] of Object.entries(job.originals))
      assert.equal(sha(await fs.readFile(file)), digest);
    const run = `data/flight-updates/philippine-import-${Date.now()}`;
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
      records: 156,
      originalHashes: job.originals,
      candidateSHA256: sha(
        await fs.readFile(root + '/verified-philippine/candidate-flights.json'),
      ),
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
    const oldGroups = buildGroups(all, { evaPublicForm: true, from: job.from });
    assert.deepEqual(
      oldGroups.map((g) => g.id),
      job.groupIDs,
    );
    const groups = buildGroups([...all, ...records], {
      evaPublicForm: true,
      from: job.from,
    });
    assert.equal(groups.length, job.groupIDs.length + 2);
    const newGroups = groups.filter((g) => g.kind === 'collected_philippine');
    for (const group of newGroups) {
      assert.ok(!job.completed[group.id]);
      const receipt = receipts.get(group.url);
      const source = group.records[0].evidence!;
      const stem = `${daily}/${group.id}`;
      await fs.writeFile(stem + '.body', await fs.readFile(source.file), {
        flag: 'wx',
      });
      await fs.writeFile(
        stem + '.receipt.json',
        JSON.stringify({ ...receipt, originalEvidence: source.file }, null, 2),
        { flag: 'wx' },
      );
      const observations = group.records.map(
        ({ number, date, airport, departure, arrival, minutes }) => ({
          number,
          date,
          airport: airport!,
          departure,
          arrival,
          minutes,
        }),
      );
      for (const r of group.records)
        assert.ok(
          !ledger.entries[verificationKey(r)],
          'Existing identity cannot be overwritten',
        );
      const compared = compareObservation(
        group.records,
        observations,
        receipt.fetchedAt,
        path.resolve(stem + '.body'),
        ledger,
      );
      assert.equal(compared.verified, group.records.length);
      await atomic(stem + '.comparison.json', {
        kind: group.kind,
        scope: 'saved_rows_only',
        at: receipt.fetchedAt,
        compared,
        observations,
        evidenceFile: path.resolve(stem + '.body'),
        importEvidence: run,
      });
      job.completed[group.id] = {
        state: 'compared',
        kind: group.kind,
        records: group.records.length,
        verified: compared.verified,
        changed: 0,
        notListed: 0,
        added: 0,
        importEvidence: run,
      };
    }
    for (const [key, entry] of Object.entries(beforeEntries))
      assert.deepEqual(ledger.entries[key], entry);
    await fs.writeFile(target, JSON.stringify(snapshot, null, 2) + '\n', {
      flag: 'wx',
    });
    ledger.updatedAt = new Date().toISOString();
    job.groupIDs = groups.map((g) => g.id);
    job.records += records.length;
    job.totalGroups = groups.length;
    job.summary.completedGroups += 2;
    job.summary.totalGroups = groups.length;
    job.summary.verifiedRows += records.length;
    job.summary.importedAdditionalRows =
      (job.summary.importedAdditionalRows || 0) + records.length;
    job.catalogueTransitions = [
      ...(job.catalogueTransitions || []),
      {
        file: target,
        before: null,
        after: sha(await fs.readFile(target)),
        added: records.length,
        evidence: run,
        at: ledger.updatedAt,
      },
    ];
    job.originals[target] = sha(await fs.readFile(target));
    job.savedAt = ledger.updatedAt;
    await atomic(base + '/latest.json', ledger);
    await atomic(daily + '/progress.json', job);
    for (const [file, digest] of Object.entries(job.originals))
      assert.equal(sha(await fs.readFile(file)), digest);
    await atomic(run + '/progress.json', {
      state: 'imported_verified_pending_site_tests',
      records: 156,
      dates: 78,
      groups: 2,
      oldCatalogueFilesUnchanged: 11,
      existingLedgerEntriesUnchanged: Object.keys(beforeEntries).length,
      target,
      targetSHA256: job.originals[target],
      sourceEvidence: candidate.sources,
      networkRequests: 0,
    });
    console.log(
      JSON.stringify({
        state: 'imported_verified',
        records: 156,
        run,
        verified: job.summary.verifiedRows,
        pendingUnchanged: job.summary.pendingRows,
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
