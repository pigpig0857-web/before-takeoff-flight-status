import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findReturnFlights } from '../src/server/services/return-flights';
import snapshot from '../src/server/data/return-flights.json';
import expanded from '../src/server/data/kaohsiung-expanded-returns.json';
import ciTpe from '../src/server/data/ci-tpe-returns.json';
import {
  returnIdentity,
  type ReturnFlight,
} from '../src/features/flights/return-types';

const query = (values: Record<string, string> = {}) =>
  new URLSearchParams({
    origin: 'NRT',
    destination: 'TPE',
    date: '2026-11-10',
    notBefore: '2026-11-01T06:30:00+09:00',
    ...values,
  });
const allReturns = [...snapshot.records, ...expanded.records, ...ciTpe.records] as ReturnFlight[];
test('13156 unique inbound records and pending source excluded', () => {
  assert.equal(snapshot.records.length, 13156);
  assert.equal(
    new Set((snapshot.records as ReturnFlight[]).map(returnIdentity)).size,
    13156,
  );
  assert.ok(
    !snapshot.records.some(
      (r) => r.number === 'IT707' && r.date === '2026-10-22',
    ),
  );
});
test('all imported dates/routes remain queryable with exact published times', () => {
  const groups = new Map<string, ReturnFlight[]>();
  for (const f of allReturns) {
    const key = `${f.date}|${f.departureAirport}|${f.arrivalAirport}`;
    groups.set(key, [...(groups.get(key) || []), f]);
  }
  let compared = 0;
  for (const group of groups.values()) {
    const f = group[0];
    const result = findReturnFlights(
      query({
        date: f.date,
        origin: f.departureAirport,
        destination: f.arrivalAirport,
        notBefore: '2026-10-18T00:00:00+08:00',
      }),
    );
    assert.deepEqual(
      result.flights.map(returnIdentity).sort(),
      group.map(returnIdentity).sort(),
    );
    assert.ok(result.routeCollected && result.partial);
    compared += result.flights.length;
  }
  assert.equal(compared, allReturns.length);
});
test('return may use another airline and must return to original Taiwan airport', () => {
  const rows = findReturnFlights(query()).flights;
  assert.deepEqual(
    new Set(rows.map((r) => r.airlineCode)),
    new Set(['MM', 'IT', 'JX', 'GK', 'BR', 'CI']),
  );
  assert.ok(
    rows.every(
      (r) => r.departureAirport === 'NRT' && r.arrivalAirport === 'TPE',
    ),
  );
  const khh = findReturnFlights(query({ destination: 'KHH' })).flights;
  assert.ok(khh.length && khh.every((r) => r.arrivalAirport === 'KHH'));
});
test('same day return cannot depart before or exactly at outbound arrival', () => {
  const rows = findReturnFlights(query()).flights;
  const threshold = rows[1].departure;
  const result = findReturnFlights(query({ notBefore: threshold }));
  assert.ok(
    result.flights.every(
      (f) => Date.parse(f.departure) > Date.parse(threshold),
    ),
  );
  assert.ok(!result.flights.some((f) => f.number === rows[0].number));
});
test('missing routes are explicitly partial and not proof of zero service', () => {
  const result = findReturnFlights(query({ origin: 'ZRH' }));
  assert.equal(result.routeCollected, false);
  assert.deepEqual(result.flights, []);
  assert.equal(result.partial, true);
});
test('invalid date, route, range and missing arrival anchor rejected', () => {
  const invalid: Record<string, string>[] = [
    { date: '2026-02-30' },
    { date: '2027-01-01' },
    { date: '2026-10-18' },
    { origin: '../' },
    { destination: 'NRT' },
    { notBefore: '' },
    { notBefore: 'garbage' },
  ];
  for (const values of invalid)
    assert.throws(() => findReturnFlights(query(values)));
});
test('cross-year arrival and origin time zones preserved', () => {
  const rows = findReturnFlights(
    query({ origin: 'NGO', date: '2026-12-31' }),
  ).flights;
  const peach = rows.find((r) => r.number === 'MM723')!;
  assert.ok(peach.arrival.startsWith('2027-01-01T01:30'));
  assert.equal(peach.departureTimeZone, 'Asia/Tokyo');
  assert.equal(peach.arrivalTimeZone, 'Asia/Taipei');
  assert.equal(
    peach.minutes,
    (Date.parse(peach.arrival) - Date.parse(peach.departure)) / 60000,
  );
});
test('non-Japan routes and US date-line arrival retain published local times', () => {
  for (const [origin, number] of [
    ['ICN', '7C6101'],
    ['SGN', 'VN570'],
    ['MNL', 'PR890'],
    ['BKK', 'JX742'],
  ]) {
    const rows = findReturnFlights(query({ origin })).flights;
    assert.ok(
      rows.some((f) => f.number === number),
      `${origin} ${number}`,
    );
  }
  const flight = findReturnFlights(query({ origin: 'LAX' })).flights.find(
    (f) => f.number === 'JX1',
  )!;
  assert.equal(flight.departure, '2026-11-10T22:50:00-08:00');
  assert.equal(flight.arrival, '2026-11-12T05:30:00+08:00');
  assert.equal(flight.minutes, 880);
});
test('airport-sourced returns disclose OAG provenance and December NU301 is now supported', () => {
  const rows = findReturnFlights(query({ origin: 'KIX' })).flights;
  assert.match(rows.find((f) => f.number === 'BR177')!.sourceNotice!, /OAG/);
  assert.match(rows.find((f) => f.number === 'GK57')!.sourceNotice!, /OAG/);
  assert.ok(
    snapshot.records.filter(
      (f) => f.number === 'NU301' && f.date.startsWith('2026-12'),
    ).length === 31,
  );
});
test('new EVA and JTA return schedules are queryable while unresolved dates stay excluded', () => {
  const tokyo = findReturnFlights(query()).flights;
  assert.ok(tokyo.some((f) => f.airlineCode === 'BR'));
  const october = findReturnFlights(
    query({
      origin: 'OKA',
      date: '2026-10-24',
      notBefore: '2026-10-20T00:00:00+08:00',
    }),
  ).flights;
  const flight = october.find((f) => f.number === 'NU307')!;
  assert.equal(flight.departure, '2026-10-24T18:05:00+09:00');
  assert.equal(flight.arrival, '2026-10-24T18:40:00+08:00');
  assert.equal(flight.minutes, 95);
  assert.ok(
    findReturnFlights(query({ origin: 'OKA' })).flights.some(
      (f) => f.number === 'NU301',
    ),
  );
  assert.ok(
    findReturnFlights(
      query({ origin: 'OKA', date: '2026-12-10' }),
    ).flights.some((f) => f.number === 'NU301'),
  );
  assert.ok(
    findReturnFlights(query({ origin: 'CDG' })).flights.some(
      (f) => f.airlineCode === 'BR',
    ),
  );
  assert.ok(
    findReturnFlights(
      query({ origin: 'DEL', date: '2026-12-02' }),
    ).flights.some((f) => f.airlineCode === 'BR'),
  );
});

test('October 28 CTS-KHH includes airport-published SL393 alongside Tigerair on other days', () => {
  const found = findReturnFlights(
    query({
      origin: 'CTS',
      destination: 'KHH',
      date: '2026-10-28',
      notBefore: '2026-10-22T12:05:00+09:00',
    }),
  );
  const flight = found.flights.find((f) => f.number === 'SL393');
  assert.ok(flight);
  assert.equal(flight.departure, '2026-10-28T14:10:00+09:00');
  assert.equal(flight.arrival, '2026-10-28T18:05:00+08:00');
  assert.equal(flight.minutes, 295);
  assert.ok(!found.flights.some((f) => f.number === 'IT261'));
  assert.match(flight.sourceNotice!, /高雄航段/);
  assert.ok(
    !snapshot.records.some(
      (f) => f.number === 'SL393' && f.date > '2026-10-31',
    ),
  );
});
