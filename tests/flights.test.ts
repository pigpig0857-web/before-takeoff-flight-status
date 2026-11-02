import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/server/providers/csv';
import {
  normalizeRealtime,
  normalizeSchedule,
  deriveStatus,
} from '../src/server/providers/taoyuan';
import { filterFlights, parseFilters } from '../src/features/flights/filter';
import { taipeiDate } from '../src/lib/time';
import { createCache } from '../src/server/services/cache';
const row = {
  方向: 'D',
  航廈: 'T2',
  航空公司代碼: 'BR',
  航空公司中文: '長榮航空',
  班次: '0198',
  表訂日期: '2026-10-05+08:00',
  表訂時間: '23:40:00+08:00',
  預計日期: '2026-10-06+08:00',
  預計時間: '00:30:00+08:00',
  往來地點: 'NRT',
  往來地點中文: '東京／成田',
  往來地點英文: 'Tokyo',
  備註: '預計時間變更',
  航班動態中文: '',
  航班動態英文: '',
  機門: 'C5',
  報到櫃台: 'null',
  機型: 'B787-9',
};
test('CSV supports BOM, quoted commas, escaped quotes and embedded newlines', () => {
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n"hello,world","a""b\nnext"\r\n'), [
    { a: 'hello,world', b: 'a"b\nnext' },
  ]);
  assert.throws(() => parseCsv('a,b\n"unfinished,b'));
  assert.throws(() => parseCsv('a,b\n1,2,3'));
});
test('Taiwan date uses Taipei instead of server timezone', () => {
  assert.equal(taipeiDate(new Date('2026-10-05T16:01:00Z')), '2026-10-06');
});
test('Passenger departures exclude arrivals and cargo terminals and sanitize null', () => {
  const flights = normalizeRealtime(
    [row, { ...row, 方向: 'A' }, { ...row, 航廈: 'Cargo' }],
    '2026-10-05',
  );
  assert.equal(flights.length, 1);
  assert.equal(flights[0].number, 'BR198');
  assert.equal(flights[0].counter, null);
  assert.equal(flights[0].reportedDeparture, '2026-10-06T00:30:00+08:00');
  assert.equal(flights[0].status, 'delayed');
});
test('Delay crossing midnight keeps original departure date for search', () => {
  const flights = normalizeRealtime([row], '2026-10-05');
  const filters = parseFilters(
    new URLSearchParams('date=2026-10-05&q=br%20198&start=23:00&end=23:59'),
    '2026-10-05',
  );
  assert.equal(filterFlights(flights, filters).length, 1);
  assert.equal(
    filterFlights(flights, { ...filters, date: '2026-10-06' }).length,
    0,
  );
});
test('Blank status does not imply on time and future never implies live boarding', () => {
  assert.equal(deriveStatus('', row['表訂時間'], null, false), 'unconfirmed');
  assert.equal(
    deriveStatus('開始登機', row['表訂時間'], null, true),
    'scheduled',
  );
  assert.equal(deriveStatus('取消 Cancelled', '', null, false), 'cancelled');
  assert.equal(deriveStatus('取消 Cancelled', '', null, true), 'cancelled');
  assert.equal(deriveStatus('已飛 Flew', '', null, false), 'departed');
});
test('Flight numbers accept leading zeros and never match a different longer number', () => {
  const flights = normalizeRealtime(
    [row, { ...row, 班次: '1988' }],
    '2026-10-05',
  );
  const filters = parseFilters(
    new URLSearchParams('q=BR%200198'),
    '2026-10-05',
  );
  assert.equal(filterFlights(flights, filters).length, 1);
  assert.equal(filterFlights(flights, filters)[0].number, 'BR198');
});
test('Cache backs off repeated failures without losing the last valid retrieval time', async () => {
  const cache = createCache<number>(100, 1000, 300);
  let attempts = 0;
  await cache.get(async () => 42, 1000);
  const fail = async () => {
    attempts++;
    throw new Error('offline');
  };
  await cache.get(fail, 1200);
  const result = await cache.get(fail, 1300);
  assert.equal(attempts, 1);
  assert.equal(result.stale, true);
  assert.equal(result.fetchedAt, new Date(1000).toISOString());
  await cache.get(fail, 1501);
  assert.equal(attempts, 2);
});
test('Reject invalid dates, reversed ranges, unknown statuses and oversized queries', () => {
  for (const query of [
    'date=2026-02-30',
    'start=18:00&end=06:00',
    'start=25:00',
    'status=wrong',
    `q=${'a'.repeat(101)}`,
  ])
    assert.throws(() => parseFilters(new URLSearchParams(query), '2026-10-05'));
});
test('Schedule only includes TPE flights with positively identified passenger numbers', () => {
  const reference = normalizeRealtime([row], '2026-10-05');
  const schedule = {
    飛行日期: '2026-10-06+08:00',
    航空公司: 'BR',
    航班號: 'BR0198',
    出發地: 'TPE',
    表訂起飛時間: '2026-10-06T23:40:00+08:00',
    目的地: 'NRT',
  };
  const flights = normalizeSchedule(
    [schedule, { ...schedule, 航班號: 'FX1' }, { ...schedule, 出發地: 'TSA' }],
    reference,
  );
  assert.equal(flights.length, 1);
  assert.equal(flights[0].status, 'scheduled');
  assert.equal(flights[0].gate, null);
  assert.equal(flights[0].date, '2026-10-06');
});
test('Do not merge unrelated flight numbers that happen to share time and destination', () => {
  const flights = normalizeRealtime(
    [row, { ...row, 航空公司代碼: 'CI', 班次: '198' }],
    '2026-10-05',
  );
  assert.equal(flights.length, 2);
});
test('Cache shares concurrent requests, reuses TTL, marks failure stale, eventually expires', async () => {
  const cache = createCache<number>(100, 1000);
  let calls = 0;
  const load = async () => {
    calls++;
    return 42;
  };
  const [a, b] = await Promise.all([
    cache.get(load, 1000),
    cache.get(load, 1000),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.value, b.value);
  await cache.get(load, 1050);
  assert.equal(calls, 1);
  const fail = async () => {
    throw new Error('offline');
  };
  const stale = await cache.get(fail, 1200);
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, new Date(1000).toISOString());
  await assert.rejects(() => cache.get(fail, 2101));
});
