import test from 'node:test';
import assert from 'node:assert/strict';
import snapshot from '../src/server/data/peach-flights.json';
import checks from '../src/server/data/peach-booking-checks.json';
import progress from '../src/server/data/peach-verification-progress.json';
import {
  normalizeCollected,
  type SavedFlight,
} from '../src/server/providers/collected';
import { enrichPeachFlight } from '../src/server/providers/peach-enrichment';

const flights = snapshot.records.map((record) =>
  normalizeCollected(record as SavedFlight),
);
test('Imported booking checks enrich only corresponding dated flights and retain the 11 year-end checks', () => {
  assert.ok(checks.records.length >= 11);
  const checked = flights
    .map((flight) => enrichPeachFlight(flight))
    .filter((flight) => flight.bookingCheck);
  assert.equal(checked.length, checks.records.length);
  assert.equal(
    checked.filter((flight) => flight.date === '2026-12-31').length,
    11,
  );
  assert.ok(checked.every((flight) => flight.aircraft === null));
  assert.equal(
    checked.find((flight) => flight.number === 'MM026')?.bookingCheck?.aircraft,
    'A321LR',
  );
  assert.equal(
    checked.find(
      (flight) => flight.number === 'MM922' && flight.date === '2026-12-31',
    )?.bookingCheck?.aircraft,
    'A320',
  );
  assert.equal(
    checked.find((flight) => flight.number === 'MM860')?.scheduledArrival,
    '2027-01-01T00:50:00+09:00',
  );
  assert.ok(
    flights
      .filter(
        (flight) =>
          !checks.records.some(
            (check) =>
              check.date === flight.date &&
              check.number === flight.number &&
              check.airport === flight.destinationCode,
          ),
      )
      .every((flight) => !enrichPeachFlight(flight).bookingCheck),
  );
});
test('Collection failures and an absent booking row retain flights and unknown fields', () => {
  const f = (date: string, number: string) =>
    enrichPeachFlight(
      flights.find(
        (flight) => flight.date === date && flight.number === number,
      )!,
    );
  assert.equal(f('2026-10-13', 'MM6924').bookingCheck?.aircraft, 'A320neo');
  assert.equal(
    f('2026-10-13', 'MM6924').scheduledArrival,
    '2026-10-13T17:45:00+09:00',
  );
  assert.equal(
    f('2026-10-12', 'MM922').bookingVerification?.state,
    'not_listed',
  );
  for (const row of progress.records.filter(
    (record) => record.state !== 'verified',
  )) {
    const unfinished = f(row.date, row.number);
    assert.equal(unfinished.bookingVerification?.state, row.state);
    assert.equal(unfinished.bookingCheck, undefined);
    assert.equal(unfinished.status, 'scheduled');
    assert.equal(unfinished.aircraft, null);
  }
});
test('All 885 Peach flights get sourced guidance without inventing dated terminals', () => {
  const enriched = flights.map((flight) => enrichPeachFlight(flight));
  assert.equal(enriched.length, 885);
  assert.ok(
    enriched.every(
      (flight) => flight.airportGuidance?.scope === 'airline_airport_guide',
    ),
  );
  assert.ok(
    enriched.every(
      (flight) => flight.terminal === null && flight.arrivalTerminal === null,
    ),
  );
  assert.equal(
    enriched.find((flight) => flight.destinationCode === 'HND')?.airportGuidance
      ?.arrival.arrivalLabel,
    '第三航廈2樓',
  );
  assert.equal(
    enriched.find((flight) => flight.destinationCode === 'OKA')?.airportGuidance
      ?.arrival.arrivalLabel,
    '旅客航廈1樓',
  );
  assert.ok(
    enriched.every(
      (flight) =>
        flight.airportGuidance?.departure.departureLabel === '第一航廈1–3樓',
    ),
  );
});
test('Dated aircraft evidence requires the same date, number, airport and both times', () => {
  const f = flights.find(
    (flight) => flight.date === '2026-12-31' && flight.number === 'MM620',
  )!;
  const check = {
    date: f.date,
    airport: f.destinationCode,
    number: f.number,
    departure: f.scheduledDeparture,
    arrival: f.scheduledArrival!,
    aircraft: 'A320neo',
    fetchedAt: '2026-10-12T03:30:00Z',
    url: 'https://booking.flypeach.com/en/',
  };
  assert.equal(enrichPeachFlight(f, [check]).bookingCheck?.aircraft, 'A320neo');
  for (const override of [
    { date: '2026-12-30' },
    { airport: 'KIX' },
    { number: 'MM626' },
    { departure: '2026-12-31T03:25:00+08:00' },
    { arrival: '2026-12-31T07:30:00+09:00' },
    { aircraft: 'guessed' },
    { fetchedAt: 'invalid' },
    { url: 'https://example.com/' },
  ]) {
    assert.equal(
      enrichPeachFlight(f, [{ ...check, ...override }]).bookingCheck,
      undefined,
    );
  }
  const live = {
    ...f,
    terminal: 'T1',
    gate: 'A1',
    aircraft: 'A321',
    source: 'realtime' as const,
  };
  assert.equal(enrichPeachFlight(live, [check]).aircraft, 'A321');
  assert.equal(enrichPeachFlight(live, [check]).gate, 'A1');
  const previouslyChecked = enrichPeachFlight(f, [check]);
  assert.equal(
    enrichPeachFlight(
      { ...previouslyChecked, scheduledDeparture: '2026-12-31T03:25:00+08:00' },
      [check],
    ).bookingCheck,
    undefined,
  );
});
test('Guidance never applies to other airlines, demo or unknown destinations', () => {
  const f = flights[0];
  for (const override of [
    { airlineCode: 'BR', number: 'BR198' },
    { source: 'demo' as const },
    { destinationCode: 'BKK' },
  ]) {
    const other = { ...f, ...override };
    assert.equal(enrichPeachFlight(other), other);
  }
});
