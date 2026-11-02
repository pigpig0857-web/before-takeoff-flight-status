import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { taipeiDate } from '../../src/lib/time';
import {
  verificationKey,
  verificationFingerprint,
  type VerificationLedger,
} from '../../src/server/services/timetable-verification';
import { compareObservation } from './compare';
import { sha, type Group } from './sources';
const read = async (file: string) =>
  JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
/** Reuse only complete, matching, successful Vietnam groups from today's focused task. No network or ledger mutation. */
export async function reuseFocusedResults(
  base: string,
  date: string,
  groups: Group[],
  ledger: VerificationLedger,
) {
  const root = path.join(base, 'focused', date + '-pending167');
  let progress: any;
  try {
    progress = await read(path.join(root, 'progress.json'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  const outcomes: Record<string, any> = {};
  for (const group of groups) {
    if (group.kind !== 'collected_vietnam') continue;
    const completed = progress.completed[group.id];
    if (
      completed?.state !== 'compared' ||
      completed.records !== group.records.length ||
      completed.verified !== group.records.length
    )
      continue;
    if (
      !group.records.every((r) => {
        const entry = ledger.entries[verificationKey(r)];
        return (
          entry?.state === 'verified' &&
          entry.fingerprint === verificationFingerprint(r) &&
          entry.verifiedAt &&
          taipeiDate(new Date(entry.verifiedAt)) === date
        );
      })
    )
      continue;
    const comparison = await read(
        path.join(root, group.id + '.comparison.json'),
      ),
      file = path.resolve(comparison.evidenceFile);
    assert.ok(file.startsWith(path.resolve(root) + path.sep));
    const receipt = await read(file.replace(/\.body$/, '.receipt.json'));
    assert.equal(receipt.status, 200);
    assert.equal(receipt.url, group.url);
    assert.equal(sha(await fs.readFile(file)), receipt.sha256);
    assert.ok(
      group.records.every((r) => {
        const entry = ledger.entries[verificationKey(r)];
        return (
          entry.evidenceFile === file && entry.verifiedAt === receipt.fetchedAt
        );
      }),
    );
    const checked = compareObservation(
      group.records,
      comparison.observations,
      receipt.fetchedAt,
      file,
      { version: 1, updatedAt: receipt.fetchedAt, entries: {} },
    );
    assert.equal(checked.verified, group.records.length);
    outcomes[group.id] = {
      state: 'compared',
      kind: group.kind,
      records: group.records.length,
      verified: checked.verified,
      changed: 0,
      notListed: 0,
      added: 0,
      reusedEvidence: path.join(root, group.id + '.comparison.json'),
    };
  }
  return outcomes;
}
