import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expandTigerSnapshot,
  tigerDatePeriods,
  type TigerRule,
  type TigerSnapshot,
} from '../src/server/providers/experimental/tigerair-schedule';

function rule(overrides: Partial<TigerRule> = {}): TigerRule {
  return {
    origin: 'TPE',
    destination: 'NRT',
    carrierCode: 'IT',
    flightNumber: '200',
    departureTime: '06:10:00',
    arrivalTime: '10:35:00',
    daysOfWeek: {
      sunday: false,
      monday: false,
      tuesday: false,
      wednesday: true,
      thursday: false,
      friday: false,
      saturday: false,
    },
    operationDateSummary: '2026/10/25-2027/03/27',
    overnight: 0,
    durationInMinutes: 205,
    ...overrides,
  };
}
function snapshot(rules: TigerRule[], countryCode = 'JP'): TigerSnapshot {
  return {
    data: [
      {
        countryCode,
        stationSchedules: [
          { iataCode: rules[0].destination, schedules: rules },
        ],
      },
    ],
  };
}

test('Tiger mixed operating dates preserve exclusions, abbreviated dates and the year of a range end', () => {
  assert.deepEqual(
    tigerDatePeriods('2026/11/26-2027/03/08, 03/25, 03/26、2027/03/27'),
    [
      { from: '2026-11-26', through: '2027-03-08' },
      { from: '2027-03-25', through: '2027-03-25' },
      { from: '2027-03-26', through: '2027-03-26' },
      { from: '2027-03-27', through: '2027-03-27' },
    ],
  );
  const special = rule({
    operationDateSummary: '2026/10/28, 11/04、2026/12/30-2026/12/31',
  });
  assert.deepEqual(
    expandTigerSnapshot(
      snapshot([special]),
      '2026-10-13',
      '2026-12-31',
    ).flights.map((f) => f.date),
    ['2026-10-28', '2026-11-04', '2026-12-30'],
  );
});

test('Tiger ambiguous or invalid dates fail rather than inventing a year', () => {
  for (const value of [
    '10/25',
    '2026/02/30',
    '2026/12/30, 01/01',
    '2026/12/31-2026/10/25',
    '',
    '2026/10/25-',
  ])
    assert.throws(() => tigerDatePeriods(value), value);
});

test('Tiger local departure and arrival times account for Japan offset and season boundaries', () => {
  const result = expandTigerSnapshot(
    snapshot([rule()]),
    '2026-10-24',
    '2026-10-28',
  );
  assert.equal(result.pending.length, 0);
  assert.equal(result.flights.length, 1);
  assert.equal(result.flights[0].date, '2026-10-28');
  assert.equal(
    result.flights[0].scheduledDeparture,
    '2026-10-27T22:10:00.000Z',
  );
  assert.equal(result.flights[0].scheduledArrival, '2026-10-28T01:35:00.000Z');
  assert.equal(result.flights[0].durationMinutes, 205);
  assert.equal(result.flights[0].aircraft, null);
  assert.equal(result.flights[0].departureTerminal, null);
});

test('Tiger published overnight offset is used explicitly, with December 31 included', () => {
  const overnight = rule({
    destination: 'HKT',
    departureTime: '23:00:00',
    arrivalTime: '02:30:00',
    overnight: 1,
    durationInMinutes: 270,
    operationDateSummary: '2026/12/31',
    daysOfWeek: { ...rule().daysOfWeek, wednesday: false, thursday: true },
  });
  const result = expandTigerSnapshot(
    snapshot([overnight], 'TH'),
    '2026-12-30',
    '2026-12-31',
  );
  assert.equal(result.pending.length, 0);
  assert.equal(result.flights[0].arrivalLocalDate, '2027-01-01');
  assert.equal(result.flights[0].scheduledArrival, '2026-12-31T19:30:00.000Z');
  const missingOffset = expandTigerSnapshot(
    snapshot([{ ...overnight, overnight: 0 }], 'TH'),
    '2026-12-31',
    '2026-12-31',
  );
  assert.equal(missingOffset.flights.length, 0);
  assert.equal(missingOffset.pending.length, 1);
});

test('Tiger conflicting rules are quarantined without picking a winner', () => {
  const changed = rule({ departureTime: '06:35:00', durationInMinutes: 180 });
  const result = expandTigerSnapshot(
    snapshot([rule(), changed, rule()]),
    '2026-11-25',
    '2026-11-25',
  );
  assert.equal(result.flights.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].observations.length, 3);
});

test('Tiger identical overlapping rules retain both source references and a single flight', () => {
  const result = expandTigerSnapshot(
    snapshot([rule(), rule()]),
    '2026-11-25',
    '2026-11-25',
  );
  assert.equal(result.flights.length, 1);
  assert.deepEqual(result.flights[0].sourceRuleIndexes, [0, 1]);
  assert.equal(result.identicalOverlap, 1);
});

test('Tiger rejects missing required evidence or mismatched country, duration and carrier', () => {
  const incomplete = { ...rule().daysOfWeek };
  delete (incomplete as Partial<typeof incomplete>).monday;
  for (const overrides of [
    { durationInMinutes: 180 },
    { carrierCode: 'BR' },
    { departureTime: '24:00:00' },
    { daysOfWeek: incomplete },
    { operationDateSummary: '2026/02/30' },
  ]) {
    const result = expandTigerSnapshot(
      snapshot([rule(overrides)]),
      '2026-11-25',
      '2026-11-25',
    );
    assert.equal(result.flights.length, 0);
    assert.equal(result.pending.length, 1);
  }
  assert.equal(
    expandTigerSnapshot(snapshot([rule()], 'TH'), '2026-11-25', '2026-11-25')
      .pending.length,
    1,
  );
});

test('Tiger excludes inbound and other origins; missing timezone stays pending until evidence is supplied', () => {
  assert.equal(
    expandTigerSnapshot(
      snapshot([rule({ origin: 'NRT' })]),
      '2026-11-25',
      '2026-11-25',
    ).tpeRules,
    0,
  );
  const akita = rule({ destination: 'AAA', durationInMinutes: 1345 });
  assert.equal(
    expandTigerSnapshot(snapshot([akita], 'PF'), '2026-11-25', '2026-11-25')
      .pending.length,
    1,
  );
  const result = expandTigerSnapshot(
    snapshot([akita], 'PF'),
    '2026-11-25',
    '2026-11-25',
    { AAA: 'Pacific/Tahiti' },
  );
  assert.equal(result.pending.length, 0);
  assert.equal(result.flights.length, 1);
});
