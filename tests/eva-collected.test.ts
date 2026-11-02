import test from 'node:test';
import assert from 'node:assert/strict';
import evaSnapshot from '../src/server/data/eva-flights.json';
import { filterFlights } from '../src/features/flights/filter';
import {
  normalizeCollected,
  preferOfficialEva,
  type SavedFlight,
  collectedDataset,
  mergeCollectedFlights,
  type CollectedSnapshot,
} from '../src/server/providers/collected';
const record: SavedFlight = {
  number: 'BR184',
  airline: '長榮航空',
  date: '2026-12-31',
  departure: '2026-12-31T07:55:00+08:00',
  arrival: '2026-12-31T12:00:00+09:00',
  arrivalTimeZone: 'Asia/Tokyo',
  airport: 'NRT',
  candidateAirport: null,
  destination: '東京',
  destinationEnglish: 'Tokyo Narita',
  countryCode: 'JP',
  terminal: null,
  arrivalTerminal: null,
  aircraft: null,
  minutes: 185,
  kind: 'collected_eva',
  label: '長榮官方預定班表',
  url: 'https://booking.evaair.com/flyeva/eva/b2c/flight-schedules.aspx?lang=en-hk',
  fetchedAt: '2026-10-08T03:00:00Z',
  operatingAirline: '長榮航空',
  operatingNumber: 'BR184',
  codeshare: false,
  page: null,
};
test('Official EVA tables retain arrival time and leave unsupported locations unknown', () => {
  const f = normalizeCollected(record);
  assert.equal(f.source, 'collected_eva');
  assert.equal(f.scheduledArrival, record.arrival);
  assert.equal(f.terminal, null);
  assert.equal(f.gate, null);
  assert.equal(f.status, 'scheduled');
});
test('Imported year-end data covers every day and supports new country/city searches', () => {
  const data = collectedDataset(
    evaSnapshot as CollectedSnapshot,
    '2026-10-08',
    Date.parse('2026-10-08T04:00:00Z'),
  );
  assert.equal(new Set(data.flights.map((f) => f.date)).size, 85);
  assert.ok(
    data.flights.every(
      (f) =>
        f.date >= '2026-10-08' &&
        f.date <= '2026-12-31' &&
        f.airlineCode === 'BR',
    ),
  );
  const query = (date: string, q: string, start = '00:00') =>
    filterFlights(data.flights, { date, q, start, end: '23:59', status: '' });
  assert.ok(query('2026-12-31', '日本東京').length > 0);
  assert.ok(query('2026-12-31', '韓國首爾').length > 0);
  assert.ok(
    query('2026-12-30', '印度新德里').every((f) => f.destinationCode === 'DEL'),
  );
  assert.equal(query('2026-12-30', '印度新德里').length, 1);
  assert.ok(
    query('2026-12-31', '日本松山').some((f) => f.destinationCode === 'MYJ'),
  );
  assert.equal(query('2027-01-01', '').length, 0);
  assert.ok(
    query('2026-12-31', '日本東京', '12:00').every(
      (f) => f.scheduledDeparture.slice(11, 16) >= '12:00',
    ),
  );
});
test('EVA source cannot accept booking-site URLs or partner-operated services', () => {
  assert.throws(() =>
    normalizeCollected({ ...record, url: 'https://tw.trip.com/flights/' }),
  );
  assert.throws(() =>
    normalizeCollected({
      ...record,
      operatingAirline: 'Asiana Airlines',
      codeshare: true,
    }),
  );
});
test('Detailed fields require matching official evidence for that departure date', () => {
  const enriched = {
    ...record,
    terminal: 'T2',
    arrivalTerminal: '1',
    aircraft: '787-10',
    detail: {
      url: 'https://booking.evaair.com/flyeva/eva/b2c/flight-details.aspx?Week_DT=12/31/2026',
      fetchedAt: '2026-10-08T04:00:00Z',
      departureTerminal: 'T2',
      arrivalTerminal: '1',
      aircraft: '787-10',
      scope: 'segment' as const,
      nonstop: true as const,
    },
  };
  const normalized = normalizeCollected(enriched);
  assert.equal(normalized.aircraft, '787-10');
  assert.equal(normalized.collected?.detail?.scope, 'segment');
  const primary = { ...normalized, source: 'realtime' as const, aircraft: null, gate: 'C5', collected: undefined };
  const merged = mergeCollectedFlights([primary], [normalized]);
  assert.equal(merged[0].aircraft, '787-10');
  assert.equal(merged[0].gate, 'C5');
  assert.equal(mergeCollectedFlights([{...primary,aircraft:'777-300ER'}], [normalized])[0].aircraft,'777-300ER');
  assert.equal(mergeCollectedFlights([{...primary,scheduledDeparture:'2026-12-31T08:30:00+08:00'}],[normalized])[0].collected,undefined);
  assert.throws(() =>
    normalizeCollected({
      ...enriched,
      date: '2026-12-30',
      departure: '2026-12-30T07:55:00+08:00',
      arrival: '2026-12-30T12:00:00+09:00',
    }),
  );
  assert.throws(() =>
    normalizeCollected({ ...enriched, aircraft: '777-300ER' }),
  );
  assert.throws(() =>
    normalizeCollected({
      ...enriched,
      detail: {
        ...enriched.detail,
        url: 'https://example.com/?Week_DT=12/31/2026',
      },
    }),
  );
});
test('Fresh official schedule supersedes earlier booking-site departure, without affecting other airlines', () => {
  const current = normalizeCollected(record);
  const old = {
    ...current,
    id: 'old-trip',
    source: 'collected_trip' as const,
    number: 'BR0184',
    scheduledDeparture: '2026-12-31T08:00:00+08:00',
  };
  const other = { ...old, id: 'other', number: 'CI100' };
  const merged = preferOfficialEva([old, other], [current]);
  assert.equal(merged.length, 2);
  assert.equal(
    merged.find((f) => f.number === 'BR184')?.scheduledDeparture,
    record.departure,
  );
  assert.ok(merged.includes(other));
});
