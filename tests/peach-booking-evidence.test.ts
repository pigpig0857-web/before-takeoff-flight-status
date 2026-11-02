import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import snapshot from '../src/server/data/peach-flights.json';
// @ts-expect-error Shared native crawler parser.
import { comparePeachBookingQuery } from '../scripts/crawler/peach-booking-evidence.mjs';

const text = fs.readFileSync(
  new URL('./fixtures/peach-booking/oka-20261013.txt', import.meta.url),
  'utf8',
);
const query = {
  date: '2026-10-13',
  airport: 'OKA',
  url: 'https://booking.flypeach.com/en/',
  fetchedAt: '2026-10-12T05:00:00Z',
  rows: [
    ['MM922A320neo', '09:3512:20', '1h45m'],
    ['MM6924A320neo', '15:0017:45', '1h45m'],
    ['MM930A320neo', '18:0520:50', '1h45m'],
  ],
};
test('Visible summer booking times compare in Japan time, preserving stored +08 instants', () => {
  const equivalent = snapshot.records.map((record) =>
    record.number === 'MM6924' && record.date === query.date
      ? { ...record, arrival: '2026-10-13T16:45:00+08:00' }
      : record,
  );
  const result = comparePeachBookingQuery(query, text, equivalent);
  assert.equal(result.records.length, 3);
  assert.equal(result.differences.length, 0);
  assert.equal(result.missing.length, 0);
  assert.equal(result.records[1].arrival, '2026-10-13T16:45:00+08:00');
  assert.equal(result.records[1].aircraft, 'A320neo');
});
test('Wrong dates, routes and unsupported saved aircraft observations fail closed', () => {
  assert.throws(() =>
    comparePeachBookingQuery(
      { ...query, date: '2026-10-14' },
      text,
      snapshot.records,
    ),
  );
  assert.throws(() =>
    comparePeachBookingQuery(
      { ...query, airport: 'KIX' },
      text,
      snapshot.records,
    ),
  );
  assert.throws(() =>
    comparePeachBookingQuery(
      { ...query, rows: [['MM922A321LR', '09:3512:20', '1h45m']] },
      text,
      snapshot.records,
    ),
  );
  assert.throws(() =>
    comparePeachBookingQuery(
      { ...query, rows: [...query.rows, query.rows[0]] },
      text,
      snapshot.records,
    ),
  );
});
test('Unlisted flights remain distinct from cancellation and timetable discrepancies', () => {
  const result = comparePeachBookingQuery(
    { ...query, rows: query.rows.slice(1) },
    text,
    snapshot.records,
  );
  assert.equal(result.records.length, 2);
  assert.equal(result.missing[0].number, 'MM922');
  assert.equal(result.missing[0].state, 'not_listed');
  assert.equal(result.missing[0].reason, 'not_listed_in_booking_result');
  const changed = snapshot.records.map((record) =>
    record.number === 'MM922' && record.date === query.date
      ? { ...record, departure: '2026-10-13T09:45:00+08:00' }
      : record,
  );
  const mismatch = comparePeachBookingQuery(query, text, changed);
  assert.equal(mismatch.records.length, 2);
  assert.equal(mismatch.differences[0].reason, 'schedule_time_difference');
});
