import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import khh from '../src/server/data/kaohsiung-jeju-flights.json';
import tpe from '../src/server/data/jeju-flights.json';
import {
  normalizeCollected,
  type CollectedSnapshot,
} from '../src/server/providers/collected';
import {
  verificationKey,
  type VerificationLedger,
} from '../src/server/services/timetable-verification';
import {
  buildGroups,
  sourceVerifier,
} from '../scripts/automatic-verification/sources';
import {
  compareObservation,
  markPending,
} from '../scripts/automatic-verification/compare';
import { filterFlights } from '../src/features/flights/filter';
import { kaohsiungAirlineCodes } from '../src/features/flights/departure-airports';
import { FlightDetails } from '../src/features/flights/flight-details';
import { FutureTripPanel } from '../src/features/flights/future-trip-panel';
const saved = (khh as CollectedSnapshot).records;
const flights = saved.map(normalizeCollected);
const filters = {
  origin: 'KHH' as const,
  date: '2026-12-31',
  q: '',
  start: '00:00',
  end: '23:59',
  status: '',
};
test('KHH Jeju contains 110 own-operated source rows with preserved unknown metadata', () => {
  assert.equal(saved.length, 110);
  assert.equal(new Set(saved.map(verificationKey)).size, 110);
  assert.equal(new Set(saved.map((r) => r.date)).size, 77);
  assert.equal(saved.filter((r) => r.airport === 'GMP').length, 33);
  assert.equal(saved.filter((r) => r.airport === 'PUS').length, 77);
  for (const f of flights) {
    assert.equal(f.origin, 'KHH');
    assert.equal(f.aircraft, null);
    assert.equal(f.terminal, null);
    assert.equal(f.arrivalTerminal, null);
    assert.equal(f.gate, null);
    assert.equal(f.counter, null);
    assert.equal(f.collected!.operatingAirline, '濟州航空');
  }
});
test('KHH Jeju origin and route validation cannot accept TPE proof or unreviewed routes', () => {
  const r = saved[0];
  assert.notEqual(verificationKey(r), verificationKey({ ...r, origin: 'TPE' }));
  assert.throws(() =>
    normalizeCollected({
      ...r,
      evidence: {
        ...r.evidence!,
        query: { ...r.evidence!.query!, origin: 'TPE' },
      },
    }),
  );
  assert.throws(() =>
    normalizeCollected({
      ...r,
      airport: 'ICN',
      evidence: {
        ...r.evidence!,
        query: { ...r.evidence!.query!, airport: 'ICN' },
      },
    }),
  );
  assert.throws(() => normalizeCollected({ ...r, aircraft: 'Boeing 737-800' }));
  assert.throws(() => normalizeCollected({ ...r, terminal: 'T1' }));
  normalizeCollected((tpe as CollectedSnapshot).records[0]);
});
test('Weekly source coverage preserves 44 GMP no-flight days and seasonal flight number changes', async () => {
  const audit = JSON.parse(
    await fs.readFile(
      'data/source-samples/crawler/khh-jeju-20261016/audit.json',
      'utf8',
    ),
  );
  assert.equal(audit.checkedDateAirportCells, 154);
  assert.equal(audit.successfulNoDepartureDates.GMP.length, 44);
  for (const date of audit.successfulNoDepartureDates.GMP)
    assert.equal(
      saved.filter((r) => r.airport === 'GMP' && r.date === date).length,
      0,
    );
  assert.equal(
    saved.find((r) => r.airport === 'GMP' && r.date === '2026-10-24')!.number,
    '7C6124',
  );
  assert.equal(
    saved.find((r) => r.airport === 'GMP' && r.date === '2026-10-27')!.number,
    '7C6122',
  );
  assert.equal(
    saved
      .find((r) => r.airport === 'PUS' && r.date === '2026-10-24')!
      .departure.slice(11, 16),
    '17:00',
  );
  assert.equal(
    saved
      .find((r) => r.airport === 'PUS' && r.date === '2026-10-25')!
      .departure.slice(11, 16),
    '17:05',
  );
});
test('Country, city, airport, airline and time filters keep both KHH Korean destinations', () => {
  assert.ok(kaohsiungAirlineCodes.includes('7C'));
  for (const q of ['韓國', '濟州航空', '7C'])
    assert.equal(filterFlights(flights, { ...filters, q }).length, 2);
  assert.equal(filterFlights(flights, { ...filters, q: '首爾' }).length, 1);
  assert.equal(filterFlights(flights, { ...filters, q: 'PUS' }).length, 1);
  assert.equal(
    filterFlights(flights, { ...filters, start: '15:00' }).length,
    1,
  );
  assert.equal(filterFlights(flights, { ...filters, origin: 'TPE' }).length, 0);
  assert.equal(
    filterFlights(flights, { ...filters, date: '2026-12-30', q: 'GMP' }).length,
    0,
  );
});
test('Background verifier replays KHH raw responses using KHH requests and preserves TPE identities', async () => {
  const groups = buildGroups(saved);
  assert.equal(groups.length, 24);
  const known = new Set(saved.map(verificationKey));
  for (const group of groups) {
    const r = group.records[0],
      receipt = JSON.parse(
        await fs.readFile(
          r.evidence!.file.replace(/\.body$/, '.receipt.json'),
          'utf8',
        ),
      );
    let requests = 0;
    const verifier = sourceVerifier(
      '',
      async (url, _id, options) => {
        requests++;
        if (url.endsWith('viewScheduleInfo.do'))
          return {
            body: Buffer.from('public index'),
            at: receipt.fetchedAt,
            url,
            file: 'offline-index',
          };
        assert.equal(options?.body?.get('depStn'), 'KHH');
        assert.equal(options?.body?.get('arrStn'), group.airport);
        return {
          body: await fs.readFile(r.evidence!.file),
          at: receipt.fetchedAt,
          url,
          file: r.evidence!.file,
        };
      },
      '2026-10-16',
    );
    const observation = await verifier(group);
    const ledger: VerificationLedger = {
      version: 1,
      updatedAt: receipt.fetchedAt,
      entries: {},
    };
    const compared = compareObservation(
      group.records,
      observation.rows,
      receipt.fetchedAt,
      r.evidence!.file,
      ledger,
      known,
    );
    assert.equal(compared.verified, group.records.length);
    assert.equal(compared.added.length, 0);
    assert.equal(requests, 2);
    const prior = ledger.entries[verificationKey(r)].verifiedAt;
    markPending(
      group.records,
      ledger,
      '2026-10-17T00:00:00Z',
      'Source unavailable',
      'query_failed',
    );
    assert.equal(ledger.entries[verificationKey(r)].verifiedAt, prior);
    assert.equal(
      ledger.entries[verificationKey({ ...r, origin: 'TPE' })],
      undefined,
    );
  }
});
test('KHH Jeju details and future guidance retain Kaohsiung links, Korean local time and PUS', () => {
  const f = flights.find(
    (f) => f.date === '2026-12-31' && f.destinationCode === 'PUS',
  )!;
  const html = renderToStaticMarkup(
    createElement(FlightDetails, {
      flight: f,
      stale: false,
      onClose: () => {},
    }),
  );
  assert.match(html, /高雄|KHH/);
  assert.match(html, /韓國當地時間/);
  assert.match(html, /17:05|20:35/);
  assert.doesNotMatch(html, /桃園|taoyuan-airport|第一航廈/);
  const future = renderToStaticMarkup(
    createElement(FutureTripPanel, {
      filters: { ...filters, date: '2027-01-01', q: '釜山' },
    }),
  );
  assert.match(future, /PUS/);
  assert.match(future, /濟州航空/);
  assert.doesNotMatch(future, /桃園國際機場/);
});
