import test from 'node:test';
import assert from 'node:assert/strict';
import peachSnapshot from '../src/server/data/peach-flights.json';
import evaSnapshot from '../src/server/data/eva-flights.json';
import {
  collectedDataset,
  normalizeCollected,
  mergeCollectedFlights,
  type CollectedSnapshot,
} from '../src/server/providers/collected';
import { filterFlights } from '../src/features/flights/filter';
import { flightHasStaleData } from '../src/features/flights/result-state';

const checkedAt = Date.parse('2026-10-12T03:00:00Z');
const peach = collectedDataset(
  peachSnapshot as CollectedSnapshot,
  '2026-10-12',
  checkedAt,
);
const eva = collectedDataset(
  evaSnapshot as CollectedSnapshot,
  '2026-10-12',
  checkedAt,
);
const all = mergeCollectedFlights([], [...eva.flights, ...peach.flights]);
const query = (q: string, start = '00:00') =>
  filterFlights(all, {
    date: '2026-12-31',
    q,
    start,
    end: '23:59',
    status: '',
  });

test('Imported Peach keeps all 885 audited flights across 81 dates with source provenance', () => {
  assert.equal(peach.flights.length, 885);
  assert.equal(new Set(peach.flights.map((f) => f.date)).size, 81);
  assert.equal(new Set(peach.flights.map((f) => f.id)).size, 885);
  assert.equal(new Set(peach.flights.map((f) => f.destinationCode)).size, 5);
  assert.ok(
    peach.flights.every(
      (f) => f.source === 'collected_peach' && f.collected?.sourcePublishedAt,
    ),
  );
  assert.ok(
    peach.flights.every(
      (f) => f.terminal === null && f.aircraft === null && f.gate === null,
    ),
  );
});

test('Tokyo country/city queries combine both airlines and both airports with departure sorting', () => {
  const flights = query('日本東京');
  assert.equal(flights.length, 7);
  assert.deepEqual(
    new Set(flights.map((f) => f.airlineCode)),
    new Set(['BR', 'MM']),
  );
  assert.equal(flights.filter((f) => f.destinationCode === 'NRT').length, 6);
  assert.equal(flights.filter((f) => f.destinationCode === 'HND').length, 1);
  assert.deepEqual(
    flights.map((f) => f.scheduledDeparture),
    flights.map((f) => f.scheduledDeparture).sort(),
  );
  assert.equal(query('日本東京', '12:00').length, 3);
});

test('Airline and airport searches preserve other carriers instead of merging flight numbers', () => {
  assert.equal(query('樂桃').length, 11);
  assert.equal(query('MM').length, 11);
  assert.equal(query('HND').length, 1);
  assert.equal(query('NRT').length, 6);
  assert.equal(query('MM024').length, 1);
  assert.equal(query('MM24').length, 1);
  assert.equal(query('MM024')[0].number, 'MM024');
});

test('Peach year-end overnight arrival retains January 1 and the Japan time zone', () => {
  const f = query('MM860')[0];
  assert.equal(f.scheduledArrival, '2027-01-01T00:50:00+09:00');
  assert.equal(f.durationMinutes, 175);
  assert.equal(f.arrivalTimeZone, 'Asia/Tokyo');
  assert.equal(f.collected?.sourcePublishedAt, '2026-09-16');
});

test('Stale EVA data does not contaminate fresh Peach detail warnings', () => {
  const now = Date.parse('2026-10-12T03:00:00Z');
  const feeds = [...eva.feeds, ...peach.feeds];
  assert.equal(flightHasStaleData(query('MM860')[0], feeds, now), false);
  const olderEva = {
    ...query('BR184')[0],
    collected: {
      ...query('BR184')[0].collected!,
      fetchedAt: '2026-10-08T03:00:00Z',
    },
  };
  assert.equal(flightHasStaleData(olderEva, feeds, now), true);
  const stalePeachFeeds = feeds.map((feed) =>
    feed.kind === 'collected_peach'
      ? { ...feed, state: 'stale' as const }
      : feed,
  );
  assert.equal(
    flightHasStaleData(query('MM860')[0], stalePeachFeeds, now),
    false,
  );
});

test('Peach data rejects wrong domains, operators, fabricated details and invalid publication dates', () => {
  const r = peachSnapshot.records[0];
  for (const override of [
    { url: 'https://tw.trip.com/flights/' },
    { operatingAirline: '長榮航空' },
    { codeshare: true },
    { terminal: 'T1' },
    { aircraft: 'A320' },
    { sourcePublishedAt: 'invalid' },
  ])
    assert.throws(() => normalizeCollected({ ...r, ...override } as any));
});

test('Airport realtime takes precedence without losing a matching Peach arrival', () => {
  const saved = query('MM860')[0];
  const live = {
    ...saved,
    id: 'live-mm860',
    number: 'MM860',
    source: 'realtime' as const,
    status: 'delayed' as const,
    gate: 'D2',
    collected: undefined,
    scheduledArrival: null,
  };
  const merged = mergeCollectedFlights([live], [saved]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'realtime');
  assert.equal(merged[0].status, 'delayed');
  assert.equal(merged[0].gate, 'D2');
  assert.equal(merged[0].scheduledArrival, saved.scheduledArrival);
  const changed = mergeCollectedFlights(
    [{ ...live, scheduledDeparture: '2026-12-31T21:55:00+08:00' }],
    [saved],
  );
  assert.equal(changed[0].scheduledArrival, null);
});
