import test from 'node:test';
import assert from 'node:assert/strict';
import snapshot from '../src/server/data/collected-flights.json';
import {
  collectedDataset,
  normalizeCollected,
  mergeCollectedFlights,
  type CollectedSnapshot,
} from '../src/server/providers/collected';
import { filterFlights } from '../src/features/flights/filter';
import { flightResultState } from '../src/features/flights/result-state';
import { summarizeDates } from '../src/lib/time';
const saved = snapshot as CollectedSnapshot;
const dataset = collectedDataset(
  saved,
  '2026-10-06',
  Date.parse('2026-10-06T08:00:00Z'),
);
function search(date: string, q: string, start = '00:00') {
  return filterFlights(dataset.flights, {
    date,
    q,
    start,
    end: '23:59',
    status: '',
  });
}
test('Collected snapshot imports actual validated records and sparse future coverage', () => {
  assert.equal(dataset.flights.length, 1756);
  assert.equal(search('2026-12-30', '日本東京').length, 29);
  assert.equal(search('2027-01-15', '韓國').length, 21);
  assert.equal(search('2027-01-15', '雪梨').length, 2);
  assert.equal(search('2027-01-15', '舊金山').length, 7);
  assert.equal(search('2027-01-15', '曼谷').length, 17);
  assert.equal(search('2026-12-31', '').length, 0);
  assert.equal(search('2026-10-25', '').length, 0);
  assert.ok(dataset.feeds.every((f) => f.partial));
});
test('City-only PDF records can be found by country/city but do not pretend to identify an airport', () => {
  const sydney = search('2026-10-06', '澳洲雪梨');
  assert.ok(sydney.length > 0);
  assert.ok(
    sydney.every(
      (f) =>
        f.destinationCode === '' && f.collected?.candidateAirport === 'SYD',
    ),
  );
  assert.equal(search('2026-10-06', 'SYD').length, 0);
  const chengdu = search('2026-10-06', '中國成都');
  assert.equal(chengdu.length, 1);
  assert.equal(chengdu[0].collected?.candidateAirport, null);
  assert.ok(search('2026-10-06', '中國').some((f) => f.id === chengdu[0].id));
});
test('Saved arrivals retain DST, previous local day, airport terminals and missing fields', () => {
  const sfo = search('2027-01-15', 'JX012')[0];
  assert.equal(sfo.scheduledArrival, '2027-01-14T19:10:00-08:00');
  assert.equal(sfo.arrivalTerminal, 'I');
  assert.equal(sfo.durationMinutes, 665);
  const syd = search('2027-01-15', 'CI51')[0];
  assert.equal(syd.scheduledArrival, '2027-01-16T12:15:00+11:00');
  assert.equal(search('2027-01-15', 'CI837')[0].arrivalTerminal, null);
  assert.equal(syd.reportedDeparture, null);
  assert.equal(syd.status, 'scheduled');
});
test('Live status and times win; leading-zero duplicates merge only with matching departure times', () => {
  const ci = search('2026-10-06', 'CI100')[0];
  const live = {
    ...ci,
    id: 'live-ci100',
    source: 'realtime' as const,
    status: 'boarding' as const,
    gate: 'A1',
    collected: undefined,
    scheduledArrival: null,
  };
  const result = mergeCollectedFlights([live], [ci]);
  assert.equal(result.length, 1);
  assert.equal(result[0].source, 'realtime');
  assert.equal(result[0].status, 'boarding');
  assert.equal(result[0].gate, 'A1');
  assert.equal(result[0].scheduledArrival, ci.scheduledArrival);
  const zero = search('2026-10-06', 'CI51')[0];
  const changed = {
    ...zero,
    id: 'live-ci51',
    number: 'CI51',
    source: 'realtime' as const,
    destinationCode: 'SYD',
    scheduledDeparture: '2026-10-06T23:50:00+08:00',
    collected: undefined,
    scheduledArrival: null,
  };
  const different = mergeCollectedFlights([changed], [zero]);
  assert.equal(different.length, 1);
  assert.equal(different[0].scheduledDeparture, changed.scheduledDeparture);
  assert.equal(different[0].scheduledArrival, null);
});
test('Partial snapshots never imply no flights, and no data is invented between sampled dates', () => {
  const dates = [...new Set(dataset.flights.map((f) => f.date))];
  const d = { today: '2026-10-06', dates, feeds: dataset.feeds };
  assert.equal(flightResultState(d, '2026-12-30', 29), 'matches');
  assert.equal(flightResultState(d, '2026-12-30', 0), 'partial');
  assert.equal(flightResultState(d, '2026-12-31', 0), 'outside_coverage');
  const stale = collectedDataset(
    saved,
    '2026-10-07',
    Date.parse('2026-10-08T12:00:00Z'),
  );
  assert.ok(stale.feeds.every((f) => f.state === 'stale'));
  assert.ok(stale.flights.every((f) => f.date >= '2026-10-07'));
  assert.equal(stale.feeds[0].fetchedAt, dataset.feeds[0].fetchedAt);
});
test('Corrupt saved duration and zone are rejected; date summaries preserve gaps and years', () => {
  const r = saved.records[0];
  assert.throws(
    () => normalizeCollected({ ...r, minutes: r.minutes + 1 }),
    /duration/,
  );
  assert.throws(
    () => normalizeCollected({ ...r, arrivalTimeZone: 'America/Los_Angeles' }),
    /zone/,
  );
  assert.equal(
    summarizeDates([
      '2026-10-07',
      '2026-10-06',
      '2026-10-06',
      '2026-12-30',
      '2027-01-15',
    ]),
    '2026/10/06～2026/10/07、2026/12/30、2027/01/15',
  );
});
