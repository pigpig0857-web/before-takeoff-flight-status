import test from 'node:test';
import assert from 'node:assert/strict';
import jtaJson from '../src/server/data/jta-flights.json';
import jetstarJson from '../src/server/data/jetstar-flights.json';
import {
  collectedDataset,
  normalizeCollected,
  type CollectedSnapshot,
} from '../src/server/providers/collected';
import { filterFlights } from '../src/features/flights/filter';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { FlightCard } from '../src/features/flights/flight-card';

const jta = jtaJson as CollectedSnapshot,
  jetstar = jetstarJson as CollectedSnapshot;
const flights = [jta, jetstar].flatMap(
  (s) => collectedDataset(s, '2026-10-14').flights,
);
const query = (q: string, date: string) =>
  filterFlights(flights, { q, date, start: '00:00', end: '23:59', status: '' });

test('468 core-complete flights remain unique and cover the 79-day TPE scope only', () => {
  assert.equal(jta.records.length, 148);
  assert.equal(jetstar.records.length, 320);
  assert.equal(new Set(flights.map((f) => f.id)).size, 468);
  for (const snapshot of [jta, jetstar]) {
    assert.equal(new Set(snapshot.records.map((r) => r.date)).size, 79);
    assert.equal(collectedDataset(snapshot, '2027-01-01').flights.length, 0);
  }
  assert.ok(
    flights.every(
      (f) =>
        f.scheduledArrival &&
        f.arrivalTimeZone === 'Asia/Tokyo' &&
        f.collected?.countryCode === 'JP',
    ),
  );
  assert.ok(
    flights.every(
      (f) =>
        (Date.parse(f.scheduledArrival!) - Date.parse(f.scheduledDeparture)) /
          60000 ===
        f.durationMinutes,
    ),
  );
  assert.equal(query('日本越洋航空', '2026-12-31').length, 2);
  assert.equal(query('捷星日本航空', '2026-12-31').length, 5);
});
test('The 61 GK50 PDF gaps use per-date airport proof and retain OAG attribution', () => {
  const rows = jetstar.records.filter((r) => r.kind === 'collected_kix');
  assert.equal(rows.length, 61);
  assert.equal(rows[0].date, '2026-10-26');
  assert.equal(rows.at(-1)!.date, '2026-12-25');
  for (const r of rows) {
    assert.equal(r.number, 'GK50');
    assert.equal(r.evidence!.query!.date, r.date);
    assert.equal(r.departure.slice(11, 16), '02:30');
    assert.equal(r.arrival.slice(11, 16), '06:00');
    assert.equal(r.minutes, 150);
    assert.equal(r.label, '關西機場公開預定班表（OAG）');
  }
  const f = query('GK50', '2026-11-10')[0];
  assert.match(
    renderToStaticMarkup(
      createElement(FlightCard, { flight: f, onSelect: () => {} }),
    ),
    /機場公開班表（OAG）/,
  );
});
test('JTA autumn exceptions and December arrival adjustment are preserved', () => {
  assert.equal(query('NU308', '2026-10-23').length, 0);
  assert.equal(query('NU308', '2026-10-24').length, 1);
  assert.equal(
    query('NU302', '2026-11-30')[0].scheduledArrival?.slice(11, 16),
    '12:50',
  );
  assert.equal(
    query('NU302', '2026-12-01')[0].scheduledArrival?.slice(11, 16),
    '12:45',
  );
  assert.equal(
    query('NU308', '2026-12-01')[0].scheduledArrival?.slice(11, 16),
    '22:10',
  );
  assert.equal(query('NU308', '2026-12-31')[0].durationMinutes, 90);
});
test('GK16 year-end services do not appear on unpublished weekdays; Tuesday time differs', () => {
  assert.deepEqual(
    jetstar.records
      .filter((r) => r.number === 'GK16')
      .map((r) => [r.date, r.departure.slice(11, 16)]),
    [
      ['2026-12-26', '16:45'],
      ['2026-12-28', '16:45'],
      ['2026-12-29', '16:50'],
      ['2026-12-31', '16:45'],
    ],
  );
  assert.equal(query('GK16', '2026-12-27').length, 0);
  assert.equal(query('GK16', '2026-12-30').length, 0);
});
test('Unpublished fields remain unknown and guide terminal references stay separate', () => {
  assert.ok(
    jta.records.every(
      (r) =>
        r.aircraft === 'Boeing 737-800' &&
        r.terminal === 'T2' &&
        r.arrivalTerminal === null &&
        r.terminalReference?.basis === 'published_airline_airport_guide',
    ),
  );
  assert.ok(
    jetstar.records.every(
      (r) =>
        r.aircraft === null &&
        r.terminal === 'T1' &&
        r.terminalReference?.basis === 'published_timetable_route_header',
    ),
  );
  assert.ok(
    flights.every(
      (f) =>
        f.gate === null &&
        f.counter === null &&
        f.reportedDeparture === null &&
        !f.bookingCheck,
    ),
  );
});
test('Source validation rejects invented aircraft, wrong query date and source relabelling', () => {
  const gk = jetstar.records.find((r) => r.kind === 'collected_kix')!;
  assert.throws(() => normalizeCollected({ ...gk, aircraft: 'A320' }));
  assert.throws(() => normalizeCollected({ ...gk, label: '捷星官方班表' }));
  assert.throws(() =>
    normalizeCollected({
      ...gk,
      evidence: {
        ...gk.evidence!,
        query: { ...gk.evidence!.query!, date: '2026-12-31' },
      },
    }),
  );
  assert.throws(() =>
    normalizeCollected({ ...gk, url: 'https://tw.trip.com/' }),
  );
  assert.throws(() =>
    normalizeCollected({ ...jta.records[0], arrivalTerminal: '1' }),
  );
});
