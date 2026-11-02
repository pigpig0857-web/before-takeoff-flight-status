import test from 'node:test';
import assert from 'node:assert/strict';
import served from '../src/features/flights/data/taoyuan-destinations.json';
import {
  airportTimeZone,
  localArrival,
  planArrival,
  zonedParts,
  utcOffset,
  durationLabel,
  calendarDayLabel,
} from '../src/features/flights/journey-time';

test('All collected Taoyuan destinations have a supported IANA time zone', () => {
  for (const airport of served) {
    const zone = airportTimeZone(airport.code);
    assert.ok(zone, airport.code);
    assert.doesNotThrow(() => zonedParts('2026-10-06T00:00:00Z', zone));
  }
  assert.equal(airportTimeZone('UNKNOWN'), null);
});

test('Sydney arrival uses destination date and seasonal time zone, not Taiwan offset', () => {
  const plan = planArrival(
    '2026-10-06T23:30:00+08:00',
    '2026-10-07',
    '11:45',
    'Australia/Sydney',
  );
  assert.equal(plan.error, null);
  assert.equal(plan.iso, '2026-10-07T00:45:00.000Z');
  assert.equal(plan.minutes, 555);
  assert.equal(durationLabel(plan.minutes!), '9 小時 15 分鐘');
  assert.deepEqual(zonedParts(plan.iso!, 'Asia/Taipei'), {
    date: '2026-10-07',
    time: '08:45',
  });
  assert.equal(utcOffset(plan.iso!, 'Australia/Sydney'), 'UTC+11:00');
  assert.equal(
    localArrival('2026-07-07', '11:45', 'Australia/Sydney').iso,
    '2026-07-07T01:45:00.000Z',
  );
});

test('Arrival across the date line can be earlier on the local calendar', () => {
  const plan = planArrival(
    '2026-10-07T00:30:00+08:00',
    '2026-10-06',
    '19:30',
    'America/Los_Angeles',
  );
  assert.equal(plan.error, null);
  assert.equal(plan.minutes, 600);
  assert.equal(
    calendarDayLabel('2026-10-06', '2026-10-07'),
    '-1 天（當地日期）',
  );
});

test('Skipped and repeated DST hours are rejected instead of silently guessing', () => {
  assert.equal(localArrival('2026-03-29', '01:30', 'Europe/London').iso, null);
  assert.match(
    localArrival('2026-03-29', '01:30', 'Europe/London').error!,
    /不存在/,
  );
  assert.match(
    localArrival('2026-10-25', '01:30', 'Europe/London').error!,
    /兩次/,
  );
});

test('Half-hour zones, invalid dates and negative durations are handled', () => {
  assert.equal(
    localArrival('2026-10-06', '18:15', 'Asia/Kolkata').iso,
    '2026-10-06T12:45:00.000Z',
  );
  assert.equal(localArrival('2026-02-30', '10:00', 'Asia/Tokyo').iso, null);
  assert.equal(localArrival('2026-10-06', '24:00', 'Asia/Tokyo').iso, null);
  assert.equal(localArrival('2026-10-06', '10:00', 'invalid/zone').iso, null);
  assert.match(
    planArrival(
      '2026-10-06T23:30:00+08:00',
      '2026-10-06',
      '11:45',
      'Australia/Sydney',
    ).error!,
    /晚於/,
  );
  assert.match(
    planArrival(
      '2026-10-06T23:30:00+08:00',
      '2026-10-15',
      '11:45',
      'Australia/Sydney',
    ).error!,
    /72/,
  );
});
