import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStarluxWeek,
  type StarluxResponse,
  type StarluxTimetableRow,
} from '../src/server/providers/experimental/starlux-timetable';
function row(
  overrides: Partial<StarluxTimetableRow> = {},
): StarluxTimetableRow {
  return {
    flightNo: 'JX0800',
    depTime: '08:25',
    arrTime: '12:35',
    depAirport: 'TPE',
    arrAirport: 'NRT',
    aircraftCode: '351',
    aircraftModel: 'A350-1000',
    operatingAirlineCode: 'JX',
    operatingAirline: 'STARLUX Airlines',
    depTerminal: '1',
    arrTerminal: '2',
    depCity: 'Taipei',
    arrCity: 'Tokyo',
    depAirportName: 'Taoyuan International Airport',
    arrAirportName: 'Narita International Airport',
    duration: 190,
    arrivalDaysDifference: 0,
    schedule: ['2026-11-23', '2026-11-26', '2026-11-29'],
    cargoOnly: [],
    pendingApproval: [],
    stops: [],
    ...overrides,
  };
}
const response = (rows: StarluxTimetableRow[]): StarluxResponse => ({
  success: true,
  message: { code: '00000' },
  data: { timetable: rows },
});
const query = {
  destination: 'NRT',
  date: '2026-11-26',
  from: '2026-10-13',
  through: '2026-12-31',
};
test('Starlux respects explicit dates and keeps padded published number, aircraft and terminals', () => {
  const r = parseStarluxWeek(response([row()]), query);
  assert.equal(r.pending.length, 0);
  assert.equal(r.flights.length, 3);
  assert.deepEqual(
    r.flights.map((f) => f.date),
    row().schedule,
  );
  assert.equal(r.flights[0].flightNumber, 'JX800');
  assert.equal(r.flights[0].publishedFlightNumber, 'JX0800');
  assert.equal(r.flights[0].aircraft, 'A350-1000');
  assert.equal(r.flights[0].departureTerminal, '1');
  assert.equal(r.flights[0].scheduledArrival, '2026-11-23T03:35:00.000Z');
});
test('Starlux range is query +/-3 days, independent of weekday', () => {
  const r = parseStarluxWeek(
    response([row({ schedule: ['2026-10-16', '2026-10-22'] })]),
    { ...query, date: '2026-10-19' },
  );
  assert.equal(r.start, '2026-10-16');
  assert.equal(r.end, '2026-10-22');
  assert.equal(r.flights.length, 2);
  assert.equal(
    parseStarluxWeek(response([row({ schedule: ['2026-10-23'] })]), {
      ...query,
      date: '2026-10-19',
    }).pending.length,
    1,
  );
});
test('Starlux December 31 scope preserves next-day local arrival and excludes January departures', () => {
  const r = parseStarluxWeek(
    response([
      row({
        arrAirport: 'PRG',
        flightNo: 'JX0101',
        depTime: '21:15',
        arrTime: '06:05',
        duration: 950,
        arrivalDaysDifference: 1,
        schedule: ['2026-12-31', '2027-01-01'],
      }),
    ]),
    { ...query, destination: 'PRG', date: '2026-12-31' },
  );
  assert.equal(r.pending.length, 0);
  assert.equal(r.flights.length, 1);
  assert.equal(r.flights[0].arrivalLocalDate, '2027-01-01');
  assert.equal(r.flights[0].scheduledArrival, '2027-01-01T05:05:00.000Z');
});
test('Starlux US seasonal clocks use destination rules and duration, not Taiwan offset', () => {
  const sample = row({
    arrAirport: 'PHX',
    flightNo: 'JX0026',
    depTime: '20:45',
    arrTime: '17:55',
    duration: 730,
    schedule: ['2026-12-31'],
  });
  const r = parseStarluxWeek(response([sample]), {
    ...query,
    destination: 'PHX',
    date: '2026-12-31',
  });
  assert.equal(r.flights[0].scheduledArrival, '2027-01-01T00:55:00.000Z');
  assert.equal(r.pending.length, 0);
  assert.equal(
    parseStarluxWeek(response([{ ...sample, duration: 790 }]), {
      ...query,
      destination: 'PHX',
      date: '2026-12-31',
    }).pending.length,
    1,
  );
});
test('Starlux cargo-only dates are excluded, pending approval is preserved, and stop rows are deferred', () => {
  const r = parseStarluxWeek(
    response([
      row({ cargoOnly: ['2026-11-23'], pendingApproval: ['2026-11-26'] }),
    ]),
    query,
  );
  assert.equal(r.flights.length, 2);
  assert.equal(r.flights[0].approvalPending, true);
  assert.equal(r.excluded[0].reason, 'cargo_only');
  assert.equal(
    parseStarluxWeek(response([row({ stops: ['HKG'] })]), query).flights.length,
    0,
  );
  assert.equal(
    parseStarluxWeek(response([row({ operatingAirlineCode: 'AS' })]), query)
      .excluded[0].reason,
    'other_operating_airline',
  );
});
test('Starlux duplicate row identities are quarantined and unknown terminals stay null', () => {
  assert.equal(
    parseStarluxWeek(response([row(), row()]), query).conflicts.length,
    3,
  );
  assert.equal(
    parseStarluxWeek(response([row(), row()]), query).flights.length,
    0,
  );
  const r = parseStarluxWeek(
    response([
      row({ depTerminal: null, arrTerminal: null, aircraftModel: null }),
    ]),
    query,
  );
  assert.equal(r.flights[0].departureTerminal, null);
  assert.equal(r.flights[0].arrivalTerminal, null);
  assert.equal(r.flights[0].aircraft, null);
});
test('Starlux invalid response, required fields and time disagreements never become guessed flights', () => {
  assert.throws(() =>
    parseStarluxWeek({ ...response([]), success: false }, query),
  );
  for (const change of [
    { duration: 0 },
    { arrivalDaysDifference: 9 },
    { depAirport: 'KHH' },
    { depTime: '25:00' },
    { schedule: ['2026-11-23', '2026-11-23'] },
    { pendingApproval: ['2026-11-24'] },
    { depTerminal: undefined },
  ]) {
    const r = parseStarluxWeek(response([row(change)]), query);
    assert.equal(r.flights.length, 0);
    assert.equal(r.pending.length, 1);
  }
});
