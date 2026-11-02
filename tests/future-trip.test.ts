import test from 'node:test';
import assert from 'node:assert/strict';
import { flightResultState } from '../src/features/flights/result-state';
import { airlineEntrances } from '../src/features/flights/official-airlines';

test('Covered dates distinguish matches from no matching flights', () => {
  const dataset = { today: '2026-10-05', dates: ['2026-10-05', '2026-10-06'] };
  assert.equal(flightResultState(dataset, '2026-10-05', 1), 'matches');
  assert.equal(flightResultState(dataset, '2026-10-05', 0), 'no_matches');
  assert.equal(flightResultState(dataset, '2026-12-30', 0), 'outside_coverage');
});

test('Failed near-term feeds do not imply no flights or lack of far-future support', () => {
  const dataset = { today: '2026-12-31', dates: [] };
  assert.equal(flightResultState(dataset, '2026-12-31', 0), 'unavailable');
  assert.equal(flightResultState(dataset, '2027-01-01', 0), 'unavailable');
  assert.equal(flightResultState(dataset, '2027-01-02', 0), 'outside_coverage');
  const sparse = { today: '2026-10-05', dates: ['2026-10-05', '2026-10-07'] };
  assert.equal(flightResultState(sparse, '2026-10-06', 0), 'unavailable');
});

test('Countries never accidentally resolve to one airline with a similar name', () => {
  assert.deepEqual(
    airlineEntrances('中國').map((airline) => airline.code),
    ['BR', 'CI', 'MU', 'CZ', 'CA', '9C'],
  );
  assert.ok(
    airlineEntrances('日本東京').some((airline) => airline.code === 'NH'),
  );
  assert.ok(
    airlineEntrances('韓國首爾').some((airline) => airline.code === 'KE'),
  );
  assert.deepEqual(
    airlineEntrances('BR 0198').map((airline) => airline.code),
    ['BR'],
  );
  assert.deepEqual(
    airlineEntrances('星宇航空').map((airline) => airline.code),
    ['JX'],
  );
  assert.equal(airlineEntrances('').length, 4);
});

test('Destination entrances respect airports and do not suggest unrelated low-cost carriers', () => {
  assert.deepEqual(
    airlineEntrances('羽田').map((airline) => airline.code),
    ['IT', 'MM'],
  );
  assert.ok(
    airlineEntrances('日本東京').some((airline) => airline.code === 'JL'),
  );
  assert.ok(
    airlineEntrances('韓國首爾').some((airline) => airline.code === '7C'),
  );
  assert.ok(
    !airlineEntrances('美國').some(
      (airline) => airline.category === 'low_cost',
    ),
  );
  assert.deepEqual(
    airlineEntrances('中國上海')
      .filter((airline) => airline.category === 'low_cost')
      .map((airline) => airline.code),
    ['9C'],
  );
  assert.equal(airlineEntrances('7C 2602')[0].category, 'low_cost');
  assert.equal(airlineEntrances('BR198')[0].category, 'full_service');
});
