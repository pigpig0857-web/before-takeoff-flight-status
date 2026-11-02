/** Audit the focused continuation against immutable snapshots, exact receipts and the prior ledger. No network. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { taipeiDate } from '../../src/lib/time';
import {
  verificationKey,
  verificationFingerprint,
  type VerificationLedger,
} from '../../src/server/services/timetable-verification';
import {
  normalizeCollected,
  type SavedFlight,
} from '../../src/server/providers/collected';
import { sha } from './sources';
const read = async (file: string) =>
  JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
async function main() {
  const date = taipeiDate(),
    base = path.resolve('data/automatic-verification'),
    root = path.join(base, 'focused', date + '-pending167');
  const progress = await read(path.join(root, 'progress.json')),
    anchor = await read(path.join(base, 'focused/pending167-anchor.json')),
    ledger = (await read(path.join(base, 'latest.json'))) as VerificationLedger,
    before = (await read(
      path.join(root, 'before-ledger.json'),
    )) as VerificationLedger;
  assert.deepEqual(progress.targetKeys, anchor.keys);
  assert.equal(
    Object.keys(progress.completed).length,
    progress.groupIDs.length,
  );
  for (const [file, digest] of Object.entries(progress.originals))
    assert.equal(sha(await fs.readFile(file)), digest);
  let unchanged = 0;
  for (const [key, value] of Object.entries(before.entries)) {
    if (!anchor.keys.includes(key)) {
      assert.deepEqual(ledger.entries[key], value);
      unchanged++;
    }
  }
  const byAirline: any[] = [],
    all: SavedFlight[] = [];
  for (const brand of [
    'eva',
    'peach',
    'tigerair',
    'starlux',
    'jeju',
    'vietnam',
    'jta',
    'jetstar',
  ]) {
    const snapshot = await read(`src/server/data/${brand}-flights.json`),
      rows: SavedFlight[] = snapshot.records.filter(
        (r: SavedFlight) =>
          r.date >= anchor.scopeFrom && r.date <= anchor.through,
      );
    for (const r of rows) {
      normalizeCollected(r);
      assert.equal(
        ledger.entries[verificationKey(r)]?.fingerprint,
        verificationFingerprint(r),
      );
    }
    const currentRows = rows.filter((r) => r.date >= date);
    byAirline.push({
      brand,
      airline: rows[0]?.airline,
      baselineRecords: rows.length,
      verified: rows.filter(
        (r) => ledger.entries[verificationKey(r)].state === 'verified',
      ).length,
      pending: rows.filter(
        (r) => ledger.entries[verificationKey(r)].state !== 'verified',
      ).length,
      currentRecords: currentRows.length,
      currentVerified: currentRows.filter(
        (r) => ledger.entries[verificationKey(r)].state === 'verified',
      ).length,
    });
    all.push(...rows);
  }
  const checkedReceipts = new Set<string>();
  let newVerified = 0;
  const unresolved: any[] = [];
  for (const key of anchor.keys) {
    const row = all.find((r) => verificationKey(r) === key)!;
    assert.ok(row);
    const entry = ledger.entries[key];
    assert.ok(entry.evidenceFile?.startsWith(root + path.sep));
    const file = entry.evidenceFile!;
    if (!checkedReceipts.has(file)) {
      const bytes = await fs.readFile(file),
        receipt = await read(file.replace(/\.body$/, '.receipt.json'));
      assert.equal(receipt.status, 200);
      assert.equal(sha(bytes), receipt.sha256);
      assert.equal(receipt.fetchedAt, entry.attemptedAt);
      checkedReceipts.add(file);
    }
    if (entry.state === 'verified') {
      assert.equal(entry.verifiedAt, entry.attemptedAt);
      assert.notEqual(before.entries[key].state, 'verified');
      newVerified++;
    } else
      unresolved.push({
        key,
        number: row.number,
        date: row.date,
        airport: row.airport,
        state: entry.state,
        reason: entry.reason,
        evidenceFile: file,
      });
  }
  const responses = [];
  for (const file of await fs.readdir(root)) {
    if (!file.endsWith('.receipt.json')) continue;
    const receipt = await read(path.join(root, file));
    responses.push({ file, status: receipt.status, method: receipt.method });
  }
  const audit = {
    state: 'available_sources_checked_remaining_flight_unconfirmed',
    date,
    auditedAt: new Date().toISOString(),
    anchorScope: { from: anchor.scopeFrom, through: anchor.through },
    targets: 167,
    newVerified,
    remaining: unresolved.length,
    unresolved,
    requests: responses.length,
    allResponses200: responses.every((r) => r.status === 200),
    sourceGroups: Object.keys(progress.completed).length,
    protectedFilesUnchanged: Object.keys(progress.originals).length,
    otherLedgerEntriesUnchanged: unchanged,
    baselineRecords: all.length,
    cumulativeVerified: byAirline.reduce((n, a) => n + a.verified, 0),
    currentRecords: byAirline.reduce((n, a) => n + a.currentRecords, 0),
    currentVerified: byAirline.reduce((n, a) => n + a.currentVerified, 0),
    byAirline,
    allFlightsVerified: unresolved.length === 0,
  };
  await fs.writeFile(
    path.join(root, 'audit.json'),
    JSON.stringify(audit, null, 2) + '\n',
  );
  console.log(JSON.stringify(audit, null, 2));
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
