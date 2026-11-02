import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import jetstarJson from '../src/server/data/jetstar-flights.json';
import {
  normalizeCollected,
  type CollectedSnapshot,
} from '../src/server/providers/collected';
import { FlightSourceNote } from '../src/features/flights/flight-source-note';
import { flightHasStaleData } from '../src/features/flights/result-state';
import {
  verificationFingerprint,
  verificationKey,
  enrichTimetableVerification,
  type VerificationLedger,
} from '../src/server/services/timetable-verification';
import {
  compareObservation,
  markPending,
} from '../scripts/automatic-verification/compare';
import {
  assertSourceURL,
  buildGroups,
  sourceVerifier,
} from '../scripts/automatic-verification/sources';
import { validateBrowserJta } from '../scripts/automatic-verification/browser-jta';

test('Saved current browser proof confirms both JTA seasons and rejects changed footnotes or expired evidence', async () => {
  const fresh = JSON.parse(
    await readFile(
      'data/automatic-verification/runs/2026-10-14/jta.browser.json',
      'utf8',
    ),
  );
  const baseline = JSON.parse(
    await readFile(
      'data/source-samples/crawler/new-airlines-20261014/jta-browser-schedule.json',
      'utf8',
    ),
  );
  const now = Date.parse(fresh.capturedAt) + 1000;
  validateBrowserJta(fresh, baseline, now);
  const altered = structuredClone(fresh);
  altered.tables[1].rows[1][3] = '12:50';
  assert.throws(
    () => validateBrowserJta(altered, baseline, now),
    /footnotes changed/,
  );
  assert.throws(
    () => validateBrowserJta(fresh, baseline, now + 24 * 3600_000),
    /not current/,
  );
  assert.throws(() =>
    validateBrowserJta(
      { ...fresh, sourceUrl: 'https://example.org/' },
      baseline,
      now,
    ),
  );
});

const row = (jetstarJson as CollectedSnapshot).records.find(
  (r) => r.number === 'GK50' && r.date === '2026-11-10',
)!;
const at = '2026-10-14T05:00:00.000Z',
  later = '2026-10-14T06:00:00.000Z';
const observation = {
  number: row.number,
  date: row.date,
  airport: row.airport!,
  departure: row.departure,
  arrival: row.arrival,
  minutes: row.minutes,
};
const empty = (): VerificationLedger => ({
  version: 1,
  updatedAt: at,
  entries: {},
});

test('Only a matching observation creates a successful timestamp, without replacing source retrieval or saved data', () => {
  const before = JSON.stringify(row),
    ledger = empty();
  assert.equal(
    compareObservation([row], [observation], at, 'fresh.body', ledger).verified,
    1,
  );
  const f = enrichTimetableVerification(
    normalizeCollected(row),
    ledger,
    Date.parse(at),
  );
  assert.equal(f.timetableVerification?.verifiedAt, at);
  assert.equal(f.collected?.fetchedAt, row.fetchedAt);
  assert.equal(flightHasStaleData(f, [], Date.parse(at)), false);
  assert.equal(
    flightHasStaleData(f, [], Date.parse(at) + 24 * 3600_000 + 1),
    true,
  );
  assert.equal(JSON.stringify(row), before);
});
test('Source failure retains last success, never acquires the new attempt time, and remains visible even within 24h', () => {
  const ledger = empty();
  compareObservation([row], [observation], at, 'fresh.body', ledger);
  markPending([row], ledger, later, 'HTTP 403', 'query_failed');
  const f = enrichTimetableVerification(
    normalizeCollected(row),
    ledger,
    Date.parse(later),
  );
  assert.equal(f.timetableVerification?.verifiedAt, at);
  assert.equal(f.timetableVerification?.attemptedAt, later);
  assert.equal(flightHasStaleData(f, [], Date.parse(later)), true);
  const html = renderToStaticMarkup(
    createElement(FlightSourceNote, { flight: f }),
  );
  assert.match(html, /本次核對待確認/);
  assert.ok(!html.includes('超過一天未重新核對'));
});
test('Changed and omitted flights remain saved and pending, rather than being deleted or treated as cancelled', () => {
  const ledger = empty();
  compareObservation([row], [observation], at, 'fresh.body', ledger);
  const moved = {
    ...observation,
    departure: '2026-11-10T03:30:00+08:00',
    arrival: '2026-11-10T07:00:00+09:00',
  };
  assert.equal(
    compareObservation([row], [moved], later, 'changed.body', ledger).changed,
    1,
  );
  assert.equal(ledger.entries[verificationKey(row)].verifiedAt, at);
  assert.equal(
    compareObservation([row], [], later, 'empty.body', ledger).not_listed,
    1,
  );
  assert.equal(normalizeCollected(row).status, 'scheduled');
});
test('A ledger cannot refresh a changed schedule, an unrelated source, or an invalid/future success time', () => {
  const ledger = empty();
  compareObservation([row], [observation], at, 'fresh.body', ledger);
  const original = normalizeCollected(row);
  assert.equal(
    enrichTimetableVerification(
      { ...original, scheduledDeparture: '2026-11-10T04:30:00+08:00' },
      ledger,
      Date.parse(at),
    ).timetableVerification,
    undefined,
  );
  assert.equal(
    enrichTimetableVerification(
      {
        ...original,
        collected: { ...original.collected!, url: 'https://example.org/' },
      },
      ledger,
      Date.parse(at),
    ).timetableVerification,
    undefined,
  );
  ledger.entries[verificationKey(row)].verifiedAt = '2027-01-01T00:00:00Z';
  assert.equal(
    enrichTimetableVerification(original, ledger, Date.parse(at))
      .timetableVerification,
    undefined,
  );
});
test('Canonical duplicate observations are rejected; known flights in overlapping source windows are not new flights', () => {
  assert.throws(
    () =>
      compareObservation(
        [row],
        [observation, { ...observation, number: 'GK050' }],
        at,
        'duplicate.body',
        empty(),
      ),
    /Duplicate/,
  );
  assert.equal(
    compareObservation(
      [],
      [observation],
      at,
      'window.body',
      empty(),
      new Set([verificationKey(row)]),
    ).added.length,
    0,
  );
  assert.equal(
    compareObservation([], [observation], at, 'window.body', empty()).added
      .length,
    1,
  );
});
test('Plans group only the correct date/form cells and reject nonofficial sources before a request', () => {
  const rows = (jetstarJson as CollectedSnapshot).records;
  assert.equal(buildGroups(rows).length, 63); // 2 PDF sources plus 61 dated airport forms.
  for (const url of [
    'http://www.jejuair.net/en/prepare/flight/getFlightSchedule.json',
    'https://example.org/',
    'https://www.jetstar.com/jp/ja/home',
    'https://www.jal.co.jp/tw/en/offers/okinawa-jta/#evil',
  ])
    assert.throws(() => assertSourceURL(url));
  assert.equal(
    assertSourceURL(row.evidence!.sourceUrl).host,
    'www.kansai-airport.or.jp',
  );
  assert.equal(verificationFingerprint(row).length, 64);
});
test('Starlux and Tiger adapters replay saved official responses into exact existing flight times', async () => {
  for (const brand of ['starlux', 'tigerair']) {
    const snapshot = JSON.parse(
      await readFile(`src/server/data/${brand}-flights.json`, 'utf8'),
    ) as CollectedSnapshot;
    const group = buildGroups(
      snapshot.records.filter((r) => r.date >= '2026-10-14'),
    )[0];
    const body = await readFile(group.records[0].evidence!.file);
    const verify = sourceVerifier(
      'unused',
      async (url) => ({ url, body, at, file: group.records[0].evidence!.file }),
      '2026-10-14',
    );
    const result = await verify(group);
    const outcome = compareObservation(
      group.records,
      result.rows,
      at,
      'saved-fixture.body',
      empty(),
    );
    assert.equal(outcome.verified, group.records.length);
    assert.equal(outcome.changed, 0);
  }
});
