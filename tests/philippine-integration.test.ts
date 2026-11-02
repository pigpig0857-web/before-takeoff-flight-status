import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import saved from '../src/server/data/philippine-flights.json';
import {
  collectedDataset,
  normalizeCollected,
  type CollectedSnapshot,
} from '../src/server/providers/collected';
import { filterFlights } from '../src/features/flights/filter';
import {
  activeAirlines,
  taoyuanAirlines,
  isActiveAirline,
} from '../src/features/flights/airline-scope';
import { FlightDetails } from '../src/features/flights/flight-details';
import {
  buildGroups,
  sourceVerifier,
  sha,
  assertSourceURL,
  type ResponseEvidence,
} from '../scripts/automatic-verification/sources';
import {
  philippineIndex,
  philippinePublication,
} from '../src/server/providers/philippine-source';
import {
  compareObservation,
  markPending,
} from '../scripts/automatic-verification/compare';
import {
  verificationKey,
  type VerificationLedger,
} from '../src/server/services/timetable-verification';

const snapshot = saved as CollectedSnapshot;
const rows = snapshot.records;
const flights = collectedDataset(snapshot, '2026-10-15').flights;
const query = (q: string, date: string, start = '00:00', country = '') =>
  filterFlights(flights, { q, date, start, end: '23:59', status: '', country });
test('PR includes 156 unique dated departures across all 78 dates, with source hashes and complete core fields', async () => {
  assert.equal(rows.length, 156);
  assert.equal(new Set(rows.map(verificationKey)).size, 156);
  assert.equal(new Set(rows.map((r) => r.date)).size, 78);
  assert.equal(activeAirlines.length, 20);
  assert.equal(taoyuanAirlines.length, 11);
  assert.ok(flights.every(isActiveAirline));
  for (const r of rows) {
    assert.equal(r.airport, 'MNL');
    assert.equal(r.countryCode, 'PH');
    assert.equal(r.arrivalTimeZone, 'Asia/Manila');
    assert.equal(
      (Date.parse(r.arrival) - Date.parse(r.departure)) / 60000,
      r.minutes,
    );
    assert.ok(r.date >= '2026-10-15' && r.date <= '2026-12-31');
    assert.ok(r.evidence?.file && r.page && r.fetchedAt && r.sourcePublishedAt);
  }
  for (const group of buildGroups(rows)) {
    const first = group.records[0];
    const bytes = await readFile(first.evidence!.file);
    assert.equal(sha(bytes), first.evidence!.sha256);
  }
  assert.deepEqual(
    snapshot.coverage.map((s) => s.records),
    [20, 136],
  );
  assert.equal(collectedDataset(snapshot, '2027-01-01').flights.length, 0);
});
test('Summer weekday exceptions and winter season transition are preserved', () => {
  assert.deepEqual(
    query('PR', '2026-10-15').map((f) => f.number),
    ['PR891', 'PR895'],
  );
  assert.deepEqual(
    query('PR', '2026-10-17').map((f) => f.number),
    ['PR891', 'PR897'],
  );
  assert.equal(query('PR897', '2026-10-23').length, 0);
  assert.equal(query('PR897', '2026-10-24').length, 1);
  assert.equal(query('PR897', '2026-10-25').length, 0);
  assert.equal(
    query('PR891', '2026-10-24')[0].scheduledDeparture.slice(11, 16),
    '09:45',
  );
  assert.equal(
    query('PR891', '2026-10-25')[0].scheduledDeparture.slice(11, 16),
    '10:10',
  );
  assert.equal(rows.filter((r) => r.number === 'PR897').length, 4);
});
test('Country, city, airport, airline and departure time searches find PR correctly', () => {
  for (const q of ['菲律賓', '馬尼拉', 'MNL', 'PR', '菲律賓航空'])
    assert.equal(query(q, '2026-12-31').length, 2, q);
  assert.equal(query('', '2026-12-31', '00:00', 'PH').length, 2);
  assert.equal(query('PR', '2026-12-31', '20:00').length, 1);
  assert.equal(query('PR', '2027-01-01').length, 0);
});
test('Dec 31 PR895 crosses the year boundary and displays both local and Taiwan dates', () => {
  const flight = query('PR895', '2026-12-31')[0];
  assert.equal(flight.scheduledArrival, '2027-01-01T00:20:00+08:00');
  assert.equal(flight.durationMinutes, 145);
  const html = renderToStaticMarkup(
    createElement(FlightDetails, { flight, stale: false, onClose: () => {} }),
  );
  assert.match(html, /菲律賓/);
  assert.match(html, /台灣時間/);
  assert.match(html, /00:20/);
  assert.match(html, /2 小時 25 分鐘/);
  assert.match(html, /尚未取得/);
  assert.equal(flight.collected?.operatingAirline, null);
  assert.equal(flight.collected?.codeshare, null);
});
test('Unsupported operator, terminal, aircraft, source, timezone and season data are rejected', () => {
  const row = rows[0];
  for (const edit of [
    { operatingAirline: '菲律賓航空' },
    { codeshare: false },
    { terminal: 'T1' },
    { aircraft: 'A321' },
    { url: 'https://example.org/flight.pdf' },
    { date: '2026-12-31', departure: '2026-12-31T09:45:00+08:00' },
    { arrivalTimeZone: 'Asia/Tokyo' },
  ])
    assert.throws(() => normalizeCollected({ ...row, ...edit }));
  assert.doesNotThrow(() => assertSourceURL(philippineIndex));
  assert.throws(() =>
    assertSourceURL('https://www.philippineairlines.com/private'),
  );
});
test('Daily verification checks live publication and matching PDF bytes using saved evidence', async () => {
  const groups = buildGroups(rows);
  assert.equal(groups.length, 2);
  const calls: string[] = [];
  const verify = sourceVerifier(
    '',
    async (url) => {
      calls.push(url);
      if (url === philippinePublication)
        return {
          body: await readFile(
            'data/source-samples/crawler/new-airlines-20261015/pr-public-page-model.body',
          ),
          at: rows[0].fetchedAt,
          file: 'index.body',
          url,
        };
      const r = groups.find((g) => g.url === url)!.records[0];
      return {
        body: await readFile(r.evidence!.file),
        at: r.fetchedAt,
        file: r.evidence!.file,
        url,
      };
    },
    '2026-10-15',
  );
  let count = 0;
  for (const g of groups) count += (await verify(g)).rows.length;
  assert.equal(count, 156);
  assert.equal(calls.filter((u) => u === philippinePublication).length, 1);
  assert.equal(calls.length, 3);
});
test('Changed PDF, withdrawn publication and access failure cannot refresh successful verification', async () => {
  const group = buildGroups(rows)[0],
    row = group.records[0];
  const bytes = await readFile(row.evidence!.file);
  const evidence: ResponseEvidence = {
    body: bytes,
    at: row.fetchedAt,
    file: row.evidence!.file,
    url: row.url,
  };
  const changed = sourceVerifier(
    '',
    async (url) =>
      url === philippinePublication
        ? {
            ...evidence,
            body: await readFile(
              'data/source-samples/crawler/new-airlines-20261015/pr-public-page-model.body',
            ),
            url,
          }
        : {
            ...evidence,
            body: Buffer.concat([bytes, Buffer.from('\nchanged')]),
          },
    '2026-10-15',
  );
  await assert.rejects(changed(group), /PDF changed/);
  let calls = 0;
  const withdrawn = sourceVerifier(
    '',
    async (url) => {
      calls++;
      return {
        ...evidence,
        body: Buffer.from(
          JSON.stringify({
            ':path': '/content/palportal/ph/en/home/flight-timetable-page',
            ':items': { text: 'new publication' },
          }),
        ),
        url,
      };
    },
    '2026-10-15',
  );
  await assert.rejects(withdrawn(group), /no longer lists/);
  assert.equal(calls, 1);
  const denied = sourceVerifier(
    '',
    async () => {
      throw new Error('HTTP 403');
    },
    '2026-10-15',
  );
  await assert.rejects(denied(group), /403/);
  const ledger: VerificationLedger = {
    version: 1,
    updatedAt: row.fetchedAt,
    entries: {},
  };
  compareObservation(
    [row],
    [{ ...row, airport: 'MNL' }],
    row.fetchedAt,
    row.evidence!.file,
    ledger,
  );
  const later = new Date(Date.parse(row.fetchedAt) + 1000).toISOString();
  markPending([row], ledger, later, 'PDF changed', 'needs_review');
  assert.equal(ledger.entries[verificationKey(row)].verifiedAt, row.fetchedAt);
  assert.equal(ledger.entries[verificationKey(row)].attemptedAt, later);
});
