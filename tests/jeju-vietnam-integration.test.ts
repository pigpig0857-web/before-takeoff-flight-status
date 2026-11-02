import test from 'node:test';
import assert from 'node:assert/strict';
import jejuSnapshot from '../src/server/data/jeju-flights.json';
import vietnamSnapshot from '../src/server/data/vietnam-flights.json';
import {
  collectedDataset,
  normalizeCollected,
  mergeCollectedFlights,
  type CollectedSnapshot,
} from '../src/server/providers/collected';
import { filterFlights } from '../src/features/flights/filter';
import { zonedParts } from '../src/features/flights/journey-time';
import { officialAirlines } from '../src/features/flights/official-airlines';
const jeju = jejuSnapshot as CollectedSnapshot;
const vietnam = vietnamSnapshot as CollectedSnapshot;
const all = [jeju, vietnam].flatMap(
  (s) => collectedDataset(s, '2026-10-14').flights,
);
const query = (q: string, date = '2026-12-31', start = '00:00') =>
  filterFlights(all, { q, date, start, end: '23:59', status: '' });

test('Jeju/Vietnam retain 454 active flights across all 79 remaining days and no duplicate identities', () => {
  for (const [snapshot, archived, active] of [
    [jeju, 240, 237],
    [vietnam, 219, 217],
  ] as const) {
    assert.equal(snapshot.records.length, archived);
    const data = collectedDataset(snapshot, '2026-10-14');
    assert.equal(data.flights.length, active);
    assert.equal(new Set(data.flights.map((f) => f.id)).size, active);
    assert.equal(data.feeds[0].dates.length, 79);
    assert.equal(data.feeds[0].dates[0], '2026-10-14');
    assert.equal(data.feeds[0].dates.at(-1), '2026-12-31');
    assert.ok(
      data.flights.every(
        (f) => f.status === 'scheduled' && f.reportedDeparture === null,
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
    assert.equal(collectedDataset(snapshot, '2027-01-01').flights.length, 0);
  }
});
test('Full airline names take priority over country prefixes, while country and airport searches still work', () => {
  assert.equal(query('濟州航空').length, 3);
  assert.equal(query('越南航空').length, 3);
  assert.equal(query('7C6102').length, 1);
  assert.equal(query('7C06102').length, 1);
  assert.ok(query('7C').every((f) => f.airlineCode === '7C'));
  assert.ok(query('VN').every((f) => f.airlineCode === 'VN'));
  assert.equal(query('韓國首爾').length, 1);
  assert.equal(query('PUS').length, 2);
  assert.equal(query('越南').length, 3);
  assert.equal(query('胡志明市', '2026-12-28').length, 1);
  assert.equal(query('VN571', '2026-12-28', '07:45').length, 1);
  assert.equal(query('VN571', '2026-12-28', '07:46').length, 0);
});
test('Direct 12/28 official evidence supersedes the empty query; CI-operated VN marketing numbers remain excluded', () => {
  const flight = query('胡志明市', '2026-12-28')[0];
  assert.equal(flight.number, 'VN571');
  assert.equal(flight.scheduledDeparture, '2026-12-28T07:45:00+08:00');
  assert.equal(
    zonedParts(flight.scheduledArrival!, 'Asia/Ho_Chi_Minh').time,
    '10:25',
  );
  assert.equal(flight.durationMinutes, 220);
  assert.ok(flight.collected?.detail);
  assert.ok(
    vietnam.records
      .find((r) => r.number === 'VN571' && r.date === '2026-12-28')!
      .evidence!.file.includes('vietnam-recheck-20261014'),
  );
  assert.ok(
    vietnam.records.every(
      (r) =>
        !r.codeshare &&
        r.operatingAirline === '越南航空' &&
        !['VN3581', 'VN3583'].includes(r.number),
    ),
  );
  assert.equal(flight.collected?.operatingNumber, null);
  assert.match(vietnam.coverage[0].description, /河內 HAN、胡志明市 SGN/);
  assert.match(vietnam.coverage[0].description, /尚未確認全部桃園航點/);
});
test('Jeju unpublished details stay unknown, Vietnam published details and official arrival links are retained', () => {
  assert.ok(
    jeju.records.every(
      (r) =>
        r.aircraft === null &&
        r.terminal === null &&
        r.arrivalTerminal === null,
    ),
  );
  assert.ok(
    vietnam.records.every(
      (r) => r.aircraft && r.terminal === 'T2' && r.arrivalTerminal === '2',
    ),
  );
  assert.ok(all.every((f) => f.gate === null && f.counter === null));
  assert.ok(
    officialAirlines
      .find((a) => a.code === 'VN')
      ?.url.startsWith('https://www.vietnamairlines.com/'),
  );
});
test('New source validation rejects fabricated metadata, codeshares and unrelated query evidence', () => {
  const j = jeju.records[0],
    v = vietnam.records[0];
  for (const change of [
    { aircraft: 'B737-800' },
    { terminal: 'T1' },
    { countryCode: 'VN' },
    { codeshare: true },
    { operatingNumber: j.number },
    { url: 'https://tw.trip.com/' },
  ])
    assert.throws(() => normalizeCollected({ ...j, ...change }));
  assert.throws(() =>
    normalizeCollected({
      ...j,
      evidence: {
        ...j.evidence!,
        query: { origin: 'TPE', airport: j.airport!, date: '2026-12-31' },
      },
    }),
  );
  assert.throws(() =>
    normalizeCollected({
      ...v,
      evidence: {
        ...v.evidence!,
        sourceUrl: v.evidence!.sourceUrl.replace(
          'originLocationCode=TPE',
          'originLocationCode=SGN',
        ),
      },
    }),
  );
  assert.throws(() =>
    normalizeCollected({ ...v, detail: { ...v.detail!, aircraft: 'guessed' } }),
  );
});
test('Airport updates remain authoritative and changed departures do not inherit an old arrival', () => {
  const saved = query('VN571', '2026-12-28')[0];
  const primary = {
    ...saved,
    source: 'realtime' as const,
    collected: undefined,
    scheduledArrival: null,
    scheduledDeparture: '2026-12-28T08:00:00+08:00',
    status: 'changed' as const,
  };
  const merged = mergeCollectedFlights([primary], [saved]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'realtime');
  assert.equal(merged[0].scheduledArrival, null);
  assert.equal(merged[0].scheduledDeparture, primary.scheduledDeparture);
});
