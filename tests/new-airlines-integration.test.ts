import test from 'node:test';
import assert from 'node:assert/strict';
import tigerSnapshot from '../src/server/data/tigerair-flights.json';
import starSnapshot from '../src/server/data/starlux-flights.json';
import evaSnapshot from '../src/server/data/eva-flights.json';
import peachSnapshot from '../src/server/data/peach-flights.json';
import {
  collectedDataset,
  normalizeCollected,
  mergeCollectedFlights,
  type CollectedSnapshot,
} from '../src/server/providers/collected';
import { filterFlights } from '../src/features/flights/filter';
import {
  arrivalAirport,
  resolveDestination,
} from '../src/features/flights/destinations';
import { zonedParts } from '../src/features/flights/journey-time';
const tiger = collectedDataset(
  tigerSnapshot as CollectedSnapshot,
  '2026-10-13',
);
const star = collectedDataset(starSnapshot as CollectedSnapshot, '2026-10-13');
const combined = mergeCollectedFlights(
  [],
  [evaSnapshot, peachSnapshot, tigerSnapshot, starSnapshot].flatMap(
    (s) => collectedDataset(s as CollectedSnapshot, '2026-10-13').flights,
  ),
);
const query = (q: string, date = '2026-12-31', start = '00:00') =>
  filterFlights(combined, { q, date, start, end: '23:59', status: '' });

test('New airline import retains all verified dates, identities, times and distinct source kinds', () => {
  for (const [data, n, kind] of [
    [tiger, 1601, 'collected_tigerair'],
    [star, 2957, 'collected_starlux'],
  ] as const) {
    assert.equal(data.flights.length, n);
    assert.equal(new Set(data.flights.map((f) => f.id)).size, n);
    const dates = [...new Set(data.flights.map((f) => f.date))].sort();
    assert.equal(dates.length, 80);
    assert.equal(dates[0], '2026-10-13');
    assert.equal(dates.at(-1), '2026-12-31');
    assert.ok(
      data.flights.every(
        (f) =>
          f.source === kind &&
          f.collected?.fetchedAt &&
          f.collected.airportConfirmed,
      ),
    );
    assert.ok(
      data.flights.every(
        (f) =>
          (Date.parse(f.scheduledArrival!) - Date.parse(f.scheduledDeparture)) /
            60000 ===
          f.durationMinutes,
      ),
    );
  }
});
test('Tokyo and airport queries combine four airlines and keep both Tokyo airports', () => {
  const result = query('日本東京');
  assert.deepEqual(
    new Set(result.map((f) => f.airlineCode)),
    new Set(['BR', 'MM', 'IT', 'JX']),
  );
  assert.equal(result.length, 13);
  assert.deepEqual(
    new Set(result.map((f) => f.destinationCode)),
    new Set(['NRT', 'HND']),
  );
  assert.deepEqual(
    result.map((f) => f.scheduledDeparture),
    result.map((f) => f.scheduledDeparture).sort(),
  );
  assert.ok(
    query('日本東京', '2026-12-31', '15:00').every(
      (f) => zonedParts(f.scheduledDeparture, 'Asia/Taipei').time >= '15:00',
    ),
  );
  assert.ok(query('NRT').every((f) => f.destinationCode === 'NRT'));
  assert.ok(query('星宇').every((f) => f.airlineCode === 'JX'));
  assert.ok(query('虎航').every((f) => f.airlineCode === 'IT'));
  assert.deepEqual(
    query('JX0800').map((f) => f.id),
    query('JX800').map((f) => f.id),
  );
});
test('New destinations have Chinese labels and airport-specific searching without guessing daily service', () => {
  assert.equal(arrivalAirport('KCZ')?.city, '高知');
  assert.equal(arrivalAirport('HNA')?.name, '花卷機場');
  assert.ok(
    resolveDestination('日本秋田')?.airports.some((a) => a.code === 'AXT'),
  );
  const sample = tiger.flights.find((f) => f.destinationCode === 'KCZ')!;
  const results = query('日本高知', sample.date);
  assert.ok(results.length);
  assert.ok(results.every((f) => f.destinationCode === 'KCZ'));
  assert.equal(
    star.flights.filter(
      (f) => f.date === '2026-12-31' && f.destinationCode === 'PRG',
    ).length,
    0,
  );
  assert.ok(
    star.flights.some(
      (f) => f.date === '2026-12-30' && f.destinationCode === 'PRG',
    ),
  );
});
test('Star trans-Pacific previous-day arrival and European next-day arrival retain local dates', () => {
  const west = star.flights.find(
    (f) => f.date === '2026-12-31' && f.destinationCode === 'SFO',
  )!;
  assert.ok(west);
  assert.equal(
    zonedParts(west.scheduledArrival!, west.arrivalTimeZone!).date,
    '2026-12-30',
  );
  const europe = star.flights.find(
    (f) => f.date === '2026-12-30' && f.destinationCode === 'PRG',
  )!;
  assert.equal(
    zonedParts(europe.scheduledArrival!, europe.arrivalTimeZone!).date,
    '2026-12-31',
  );
  assert.equal(europe.durationMinutes, 950);
});
test('Unpublished aircraft/terminals are kept null and official details are retained only when supplied', () => {
  assert.ok(
    tiger.flights.every(
      (f) =>
        f.aircraft === null &&
        f.terminal === null &&
        f.arrivalTerminal === null,
    ),
  );
  assert.equal(star.flights.filter((f) => f.aircraft).length, 2957);
  assert.equal(star.flights.filter((f) => f.terminal).length, 2617);
  assert.equal(star.flights.filter((f) => f.arrivalTerminal).length, 1927);
  assert.ok(
    [...tiger.flights, ...star.flights].every(
      (f) => f.gate === null && f.counter === null,
    ),
  );
});
test('Three newly published Jakarta departures retain dated source evidence and unknown terminals', () => {
  for (const date of ['2026-12-14', '2026-12-21', '2026-12-24']) {
    const row = starSnapshot.records.find(
      (r) => r.number === 'JX1761' && r.date === date,
    )!;
    assert.ok(row);
    assert.equal(row.departure, `${date}T06:55:00+08:00`);
    assert.equal(row.arrival, `${date}T11:20:00+07:00`);
    assert.equal(row.minutes, 325);
    assert.equal(row.aircraft, 'A321neo');
    assert.equal(row.terminal, date === '2026-12-14' ? null : 'T2');
    assert.equal(row.arrivalTerminal, date === '2026-12-14' ? null : '3');
    assert.ok(row.evidence?.sha256);
    assert.ok(row.evidence?.sourceUrl.includes('arrAirport=CGK'));
  }
});
test('New source normalization rejects fabricated metadata, wrong domains, country and query coverage', () => {
  const r = (tigerSnapshot as CollectedSnapshot).records[0];
  for (const change of [
    { aircraft: 'A320' },
    { terminal: 'T1' },
    { url: 'https://tw.trip.com/flights' },
    { countryCode: 'TH' },
    { codeshare: true },
    { evidence: { ...r.evidence!, sha256: 'wrong' } },
    { operatingAirline: '長榮航空' },
  ])
    assert.throws(() => normalizeCollected({ ...r, ...change }));
  const s = (starSnapshot as CollectedSnapshot).records[0];
  assert.throws(() =>
    normalizeCollected({
      ...s,
      evidence: {
        ...s.evidence!,
        sourceUrl: s.evidence!.sourceUrl.replace(
          /date=[^&]+/,
          'date=2026-12-31',
        ),
      },
    }),
  );
  assert.throws(() =>
    normalizeCollected({
      ...s,
      evidence: {
        ...s.evidence!,
        sourceUrl:
          'https://ecapi.starlux-airlines.com/flightSchedule/v2/timetable?depAirport=KHH&arrAirport=SFO&date=2026-10-15',
      },
    }),
  );
});
