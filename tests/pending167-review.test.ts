import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import eva from '../src/server/data/eva-flights.json';
import {
  normalizeCollected,
  type SavedFlight,
} from '../src/server/providers/collected';
import { FlightCard } from '../src/features/flights/flight-card';
import { FlightDetails } from '../src/features/flights/flight-details';
import { timetableReviewNotice } from '../src/features/flights/verification';
import {
  readSourceStops,
  saveSourceStop,
} from '../scripts/automatic-verification/source-stops';
import { reuseFocusedResults } from '../scripts/automatic-verification/reuse-focused';
import { buildGroups } from '../scripts/automatic-verification/sources';
import { verificationKey, verificationFingerprint, type VerificationLedger } from '../src/server/services/timetable-verification';
const saved = eva.records.find(
  (r) => r.number === 'BR257' && r.date === '2026-11-24',
) as SavedFlight;
test('The daily worker reuses a fully confirmed focused group without changing its ledger or seeding a different scope', async () => {
  const base = path.resolve('data/automatic-verification');
  const snapshot = JSON.parse(
    await fs.readFile('src/server/data/vietnam-flights.json', 'utf8'),
  );
  const group = buildGroups(
    snapshot.records.filter(
      (r: SavedFlight) => r.date === '2026-12-28' && r.airport === 'SGN',
    ),
  )[0];
  // The 10/15 historical test must not depend on today's mutable ledger.
  const comparison = JSON.parse(await fs.readFile(path.join(base, 'focused', '2026-10-15-pending167', group.id + '.comparison.json'), 'utf8'));
  const receipt = JSON.parse(await fs.readFile(comparison.evidenceFile.replace(/\.body$/, '.receipt.json'), 'utf8'));
  const before: VerificationLedger = { version: 1, updatedAt: receipt.fetchedAt, entries: {} };
  for (const row of group.records) before.entries[verificationKey(row)] = {
    fingerprint: verificationFingerprint(row), state: 'verified', attemptedAt: receipt.fetchedAt,
    verifiedAt: receipt.fetchedAt, evidenceFile: comparison.evidenceFile,
  };
  const serialized = JSON.stringify(before),
    reused = await reuseFocusedResults(base, '2026-10-15', [group], before);
  assert.equal(reused[group.id].verified, 1);
  assert.equal(JSON.stringify(before), serialized);
  const incompatible = {
    ...group,
    records: [...group.records, { ...group.records[0], number: 'VN9999' }],
  };
  assert.deepEqual(
    await reuseFocusedResults(base, '2026-10-15', [incompatible], before),
    {},
  );
});
test('Unlisted BR257 remains saved but cards and details clearly show uncertainty without asserting cancellation or replacement', () => {
  const before = JSON.stringify(saved),
    flight = {
      ...normalizeCollected(saved),
      timetableVerification: {
        state: 'not_listed' as const,
        attemptedAt: '2026-10-15T01:00:00Z',
      },
    };
  for (const component of [
    createElement(FlightCard, { flight, onSelect: () => {} }),
    createElement(FlightDetails, { flight, stale: true, onClose: () => {} }),
  ]) {
    const html = renderToStaticMarkup(component);
    assert.match(html, />班次待確認</);
    assert.match(html, /本次官方班表未列出此班次/);
    assert.match(html, /是否取消或改班號尚未確認/);
    assert.ok(!html.includes('status-cancelled'));
  }
  assert.equal(flight.status, 'scheduled');
  assert.equal(JSON.stringify(saved), before);
});
test('Successful verification removes the review label; failed schedule checks never override actual live status', () => {
  const base = normalizeCollected(saved),
    failed = {
      ...base,
      timetableVerification: {
        state: 'query_failed' as const,
        attemptedAt: '2026-10-15T01:00:00Z',
      },
    };
  assert.equal(timetableReviewNotice(failed)?.label, '最新資料待核對');
  assert.equal(
    timetableReviewNotice({
      ...base,
      timetableVerification: {
        state: 'verified',
        attemptedAt: '2026-10-15T01:00:00Z',
        verifiedAt: '2026-10-15T01:00:00Z',
      },
    }),
    null,
  );
  assert.equal(
    timetableReviewNotice({
      ...failed,
      source: 'realtime',
      status: 'departed',
    }),
    null,
  );
});
test('A source stop persists across workers on the same date and cannot be overwritten, without blocking a new day', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flight-source-stop-'));
  try {
    const stop = {
      at: '2026-10-15T01:00:00Z',
      reason: 'HTTP 503',
      file: 'proof.json',
    };
    await saveSourceStop(root, '2026-10-15', 'official.example', stop);
    await saveSourceStop(root, '2026-10-15', 'official.example', {
      ...stop,
      reason: 'must not replace original denial',
    });
    assert.deepEqual(await readSourceStops(root, '2026-10-15'), {
      'official.example': stop,
    });
    assert.deepEqual(await readSourceStops(root, '2026-10-16'), {});
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
