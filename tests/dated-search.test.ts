import test from 'node:test';
import assert from 'node:assert/strict';
import { filterFlights, parseFilters } from '../src/features/flights/filter';
import {
  normalizeCollected,
  type SavedFlight,
} from '../src/server/providers/collected';
import snapshot from '../src/server/data/peach-flights.json';

test('A dated query never reads times belonging to another date', () => {
  const row = snapshot.records.find(
    (r) => r.date === '2026-12-31',
  ) as SavedFlight;
  const flight = normalizeCollected(row);
  const unrelated = {
    ...flight,
    date: '2026-12-30',
    get scheduledDeparture(): string {
      throw Error('Other date should not be formatted');
    },
  };
  const result = filterFlights(
    [unrelated, flight],
    parseFilters(new URLSearchParams({ date: '2026-12-31' }), '2026-12-31'),
  );
  assert.deepEqual(result, [flight]);
});
