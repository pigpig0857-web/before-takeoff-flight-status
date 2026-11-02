import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { taipeiDate } from '../../src/lib/time';
import { sha } from './sources';
import {
  verificationKey,
  verificationFingerprint,
  type VerificationLedger,
} from '../../src/server/services/timetable-verification';
import { parseStarluxWeek } from '../../src/server/providers/experimental/starlux-timetable';
const read = async (file: string) =>
  JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
async function main() {
  const root = path.resolve('data/automatic-verification/runs', taipeiDate());
  const job = await read(path.join(root, 'progress.json'));
  const ledger = (await read(
    'data/automatic-verification/latest.json',
  )) as VerificationLedger;
  for (const [file, digest] of Object.entries(job.originals))
    assert.equal(
      sha(await fs.readFile(file)),
      digest,
      `Original data changed: ${file}`,
    );
  const byAirline: any[] = [];
  const catalogueIdentities = new Set<string>();
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
    'kaohsiung-jeju',
    'kaohsiung-eva',
    'kaohsiung-vietnam',
    'thai-lion',
    'kaohsiung-thai-lion',
    'kaohsiung-expanded',
  ]) {
    const snapshot = await read(`src/server/data/${brand}-flights.json`);
    const records = snapshot.records.filter(
      (r: any) => r.date >= job.from && r.date <= job.through,
    );
    records.forEach((r: any) => catalogueIdentities.add(verificationKey(r)));
    const outcomes: any[] = [];
    for (const r of records) {
      const entry = ledger.entries[verificationKey(r)];
      assert.ok(entry);
      assert.equal(entry.fingerprint, verificationFingerprint(r));
      if (entry.state === 'verified') {
        assert.equal(entry.verifiedAt, entry.attemptedAt);
        assert.ok(entry.evidenceFile);
        const bytes = await fs.readFile(entry.evidenceFile!);
        if (entry.evidenceFile!.endsWith('.body')) {
          const receipt = await read(
            entry.evidenceFile!.replace(/\.body$/, '.receipt.json'),
          );
          assert.equal(receipt.status, 200);
          assert.equal(sha(bytes), receipt.sha256);
          assert.equal(receipt.fetchedAt, entry.verifiedAt);
        } else {
          assert.equal(
            JSON.parse(bytes.toString('utf8')).capturedAt,
            entry.verifiedAt,
          );
        }
      }
      outcomes.push(entry);
    }
    byAirline.push({
      brand,
      origin: records[0]?.origin || 'TPE',
      airline: records[0]?.airline,
      records: records.length,
      verified: outcomes.filter((r) => r.state === 'verified').length,
      pending: outcomes.filter((r) => r.state !== 'verified').length,
      datesVerified: new Set(
        records
          .filter(
            (r: any) => ledger.entries[verificationKey(r)].state === 'verified',
          )
          .map((r: any) => r.date),
      ).size,
    });
  }
  const added: any[] = [];
  for (const file of await fs.readdir(root)) {
    if (!file.endsWith('.comparison.json')) continue;
    const comparison = await read(path.join(root, file));
    if (!comparison.compared?.added?.length) continue;
    const receipt = await read(
      comparison.evidenceFile.replace(/\.body$/, '.receipt.json'),
    );
    const bytes = await fs.readFile(comparison.evidenceFile);
    assert.equal(sha(bytes), receipt.sha256);
    assert.equal(receipt.status, 200);
    const raw = JSON.parse(bytes.toString('utf8')),
      url = new URL(receipt.url);
    const parsed = parseStarluxWeek(raw, {
      date: url.searchParams.get('date')!,
      destination: url.searchParams.get('arrAirport')!,
      from: job.from,
      through: job.through,
    });
    assert.equal(parsed.conflicts.length, 0);
    assert.equal(parsed.pending.length, 0);
    for (const row of comparison.compared.added) {
      const match = parsed.flights.find(
        (f) =>
          f.publishedFlightNumber === row.number &&
          f.date === row.date &&
          f.destination === row.airport,
      );
      assert.ok(match);
      assert.equal(match.operatingAirlineCode, 'JX');
      assert.equal(match.approvalPending, false);
      assert.equal(
        Date.parse(match.scheduledDeparture),
        Date.parse(row.departure),
      );
      assert.equal(Date.parse(match.scheduledArrival), Date.parse(row.arrival));
      assert.equal(match.durationMinutes, row.minutes);
      added.push({
        ...row,
        aircraft: match.aircraft,
        departureTerminal: match.departureTerminal,
        arrivalTerminal: match.arrivalTerminal,
        sourceUrl: receipt.url,
        fetchedAt: receipt.fetchedAt,
        evidenceFile: comparison.evidenceFile,
        sha256: receipt.sha256,
        state: catalogueIdentities.has(verificationKey(row))
          ? 'imported_and_verified'
          : 'verified_additional_source_record_not_imported',
      });
    }
  }
  assert.equal(
    byAirline.reduce((n, a) => n + a.verified, 0),
    job.summary.verifiedRows,
  );
  for (const transition of job.catalogueTransitions || []) {
    if (
      transition.file !== 'src/server/data/eva-flights.json' ||
      !transition.added
    )
      continue;
    const difference = await read(
        path.join(transition.evidence, 'difference.json'),
      ),
      row = difference.row,
      entry = ledger.entries[verificationKey(row)];
    assert.ok(catalogueIdentities.has(verificationKey(row)));
    assert.equal(entry.state, 'verified');
    added.push({
      ...row,
      evidenceFile: entry.evidenceFile,
      state: 'imported_and_verified',
    });
  }
  const unresolved =
    job.summary.pendingRows +
    (job.summary.changedRows || 0) +
    (job.summary.notListedRows || 0);
  assert.equal(
    byAirline.reduce((n, a) => n + a.pending, 0),
    unresolved,
  );
  const audit = {
    state: 'verified_saved_progress_with_pending_sources',
    scope: { from: job.from, through: job.through, origins: ['TPE', 'KHH'] },
    auditedAt: new Date().toISOString(),
    byAirline,
    verified: job.summary.verifiedRows,
    pending: unresolved,
    newSinceReported2713: job.summary.verifiedRows - 2713,
    additionalSourceRecords: added,
    originalFilesUnchanged: Object.keys(job.originals).length,
    sourceRestrictionsRetained: true,
    allFlightsVerified: unresolved === 0,
    catalogueTransitions: job.catalogueTransitions || [],
    protectedFilesChecked: Object.keys(job.originals).length,
    catalogueFilesModifiedWithEvidence: new Set(
      (job.catalogueTransitions || []).map((t: any) => t.file),
    ).size,
    unchangedFilesSinceEnhancement:
      Object.keys(job.originals).length -
      new Set((job.catalogueTransitions || []).map((t: any) => t.file)).size,
  };
  await fs.writeFile(
    path.join(root, 'audit.json'),
    JSON.stringify(audit, null, 2) + '\n',
  );
  console.log(
    JSON.stringify(
      {
        verified: audit.verified,
        pending: audit.pending,
        newSinceReported2713: audit.newSinceReported2713,
        additionalSourceRecords: added.length,
        originalFilesUnchanged: audit.originalFilesUnchanged,
        byAirline,
      },
      null,
      2,
    ),
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
