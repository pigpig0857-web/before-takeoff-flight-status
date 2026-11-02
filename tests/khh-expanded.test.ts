import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import out from '../src/server/data/kaohsiung-expanded-flights.json';
import inbound from '../src/server/data/kaohsiung-expanded-returns.json';
import {
  normalizeCollected,
  collectedDataset,
  type CollectedSnapshot,
} from '../src/server/providers/collected';
import { getFlightDataset } from '../src/server/services/flights';
import { findReturnFlights } from '../src/server/services/return-flights';
import {
  activeAirlines,
  taoyuanAirlines,
  isActiveAirline,
} from '../src/features/flights/airline-scope';
import { kaohsiungAirlineCodes } from '../src/features/flights/departure-airports';
import { filterFlights } from '../src/features/flights/filter';
import { verificationKey } from '../src/server/services/timetable-verification';
import {
  buildGroups,
  sourceVerifier,
  sha,
} from '../scripts/automatic-verification/sources';

const root = 'data/source-samples/crawler/khh-more-airlines-20261020';
const snapshot = out as CollectedSnapshot;
const read = async (p: string) => JSON.parse(await fs.readFile(p, 'utf8'));
const flights = collectedDataset(snapshot, '2026-10-20').flights;
const python =
  'C:/Users/88697/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';

test('1533 outbound and 1538 inbound records preserve every accepted staged clock and source', async () => {
  assert.equal(out.records.length, 1533);
  assert.equal(inbound.records.length, 1538);
  const staged = (
    await read(root + '/staging/ready-for-integration-review.json')
  ).records;
  assert.equal(staged.length, 3071);
  assert.equal(new Set(flights.map((f) => f.id)).size, 1533);
  const approved = new Map(
    staged.map((r: any) => [
      `${r.date}|${r.number}|${r.departureAirport}|${r.arrivalAirport}`,
      r,
    ]),
  );
  for (const r of [
    ...out.records.map((r) => ({
      ...r,
      departureAirport: 'KHH',
      arrivalAirport: r.airport,
    })),
    ...inbound.records,
  ]) {
    const original: any = approved.get(
      `${r.date}|${r.number}|${r.departureAirport}|${r.arrivalAirport}`,
    );
    assert.ok(original);
    assert.equal(r.departure, original.departure);
    assert.equal(r.arrival, original.arrival);
    assert.equal(r.fetchedAt, original.fetchedAt);
    assert.equal(r.minutes, original.minutes);
    assert.equal(r.evidence.sha256, original.evidence.sha256);
    assert.equal(r.aircraft, null);
    assert.equal(r.terminal, null);
    assert.equal(
      (Date.parse(r.arrival) - Date.parse(r.departure)) / 60000,
      r.minutes,
    );
  }
  assert.equal(new Set(flights.map((f) => f.airlineCode)).size, 10);
});

test('all 22 original website data files remain byte-for-byte unchanged', async () => {
  const before = await read(root + '/integration/before.json');
  for (const [file, digest] of Object.entries(before))
    assert.equal(sha(await fs.readFile(file)), digest);
  const receipt = await read(root + '/integration/import.json');
  assert.equal(
    sha(await fs.readFile(receipt.outboundFile)),
    receipt.outboundSha256,
  );
  assert.equal(
    sha(await fs.readFile(receipt.inboundFile)),
    receipt.inboundSha256,
  );
});

test('user-selected 17 KIA times are adopted while UA838 five skipped dates stay excluded', () => {
  const kiaOut = out.records.filter((r) => r.kind === 'collected_khh_airport');
  const kiaIn = inbound.records.filter(
    (r) => r.sourceKind === 'collected_khh_airport',
  );
  assert.equal(kiaOut.length, 12);
  assert.equal(kiaIn.length, 5);
  assert.equal(
    kiaOut.find((r) => r.number === 'CI102' && r.date === '2026-10-21')!
      .departure,
    '2026-10-21T08:00:00+08:00',
  );
  assert.equal(
    kiaIn.find((r) => r.date === '2026-10-21')!.departure,
    '2026-10-21T17:40:00+09:00',
  );
  assert.ok(
    !out.records.some((r) => r.number === 'UA838' && r.date <= '2026-10-24'),
  );
  assert.ok(
    out.records.some((r) => r.number === 'UA838' && r.date === '2026-12-31'),
  );
  assert.ok(
    [...kiaOut, ...kiaIn].every(
      (r) => r.sourceResolution?.selectedBy === 'user',
    ),
  );
});

test('airport provenance validator rejects route, source and fake metadata mutations', () => {
  const r = snapshot.records.find((r) => r.kind === 'collected_khh_oag')!;
  for (const change of [
    { origin: 'TPE' },
    { url: 'https://example.com/' },
    { airport: 'LAX' },
    { countryCode: 'US' },
    { operatingAirline: r.airline },
    { terminal: '1' },
    { evidence: undefined },
  ]) {
    assert.throws(() => normalizeCollected({ ...r, ...change } as any));
  }
});

test('KHH retains 17 carriers while TPE includes the imported CI catalogue', async () => {
  assert.equal(kaohsiungAirlineCodes.length, 17);
  assert.equal(activeAirlines.length, 20);
  assert.equal(taoyuanAirlines.length, 11);
  assert.ok(
    isActiveAirline({ number: 'CI176', airlineCode: 'CI', origin: 'TPE' }),
  );
  assert.ok(
    isActiveAirline({ number: 'CI176', airlineCode: 'CI', origin: 'KHH' }),
  );
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Error('Unexpected network fetch');
  };
  try {
    const data = await getFlightDataset('KHH');
    assert.ok(data.flights.every((f) => f.origin === 'KHH'));
    assert.ok(
      data.flights.some(
        (f) => f.airlineCode === 'AK' && f.destinationCode === 'KUL',
      ),
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
  const japan = filterFlights(flights, {
    origin: 'KHH',
    date: '2026-12-31',
    q: '日本',
    start: '00:00',
    end: '23:59',
    status: '',
  });
  assert.deepEqual(
    new Set(japan.map((f) => f.airlineCode)),
    new Set(['CI', 'AK', 'UA', 'FD']),
  );
  assert.equal(
    filterFlights(flights, {
      date: '2026-12-31',
      q: '',
      start: '00:00',
      end: '23:59',
      status: '',
    }).length,
    0,
  );
});

test('every added inbound is queryable with its exact time and returns only to KHH', () => {
  const groups = new Map<string, typeof inbound.records>();
  for (const r of inbound.records) {
    const k = r.date + '|' + r.departureAirport;
    groups.set(k, [...(groups.get(k) || []), r]);
  }
  let count = 0;
  for (const group of groups.values()) {
    const first = group[0];
    const result = findReturnFlights(
      new URLSearchParams({
        origin: first.departureAirport,
        destination: 'KHH',
        date: first.date,
        notBefore: '2026-10-19T00:00:00+08:00',
      }),
    );
    for (const r of group) {
      const found = result.flights.find((f) => f.number === r.number);
      assert.ok(found);
      assert.equal(found.departure, r.departure);
      assert.equal(found.arrival, r.arrival);
      count++;
    }
    assert.ok(result.flights.every((r) => r.arrivalAirport === 'KHH'));
  }
  assert.equal(count, 1538);
});

test('new OAG verification groups bind the correct KHH origin/date/destination and replay saved evidence', async () => {
  const group = buildGroups(snapshot.records).find(
    (g) =>
      g.kind === 'collected_khh_oag' &&
      g.queryDate === '2026-11-26' &&
      g.airport === 'HKG',
  )!;
  assert.ok(group);
  let calls = 0;
  const verify = sourceVerifier(
    python,
    async (url, id, options) => {
      calls++;
      assert.equal(url, group.url);
      assert.equal(options?.body?.get('from'), 'KHH');
      assert.equal(options?.body?.get('to'), 'HKG');
      assert.equal(options?.body?.get('date'), '2026-11-26');
      const file = group.records[0].evidence!.file;
      return {
        body: await fs.readFile(file),
        at: group.records[0].fetchedAt,
        file,
        url,
      };
    },
    '2026-10-21',
    'test-public-token',
  );
  const result = await verify(group);
  assert.equal(calls, 1);
  for (const r of group.records) {
    const found = result.rows.find(
      (row) => verificationKey(row) === verificationKey(r),
    );
    assert.ok(found);
    assert.equal(Date.parse(found.departure), Date.parse(r.departure));
    assert.equal(Date.parse(found.arrival), Date.parse(r.arrival));
  }
});

test('KIA verification checks selected official rows and refuses to confirm an OAG time in their place', async () => {
  const group = buildGroups(snapshot.records).find(
    (g) => g.kind === 'collected_khh_airport',
  )!;
  const file = group.records[0].evidence!.file;
  const data = await fs.readFile(file);
  const verify = sourceVerifier(
    python,
    async (url) => ({ body: data, file, url, at: '2026-10-21T00:00:00Z' }),
    '2026-10-21',
  );
  assert.equal((await verify(group)).rows.length, 12);
  const changed = JSON.parse(data.toString());
  changed.forEach((r: any) => {
    if (r.airLineNum === 'CI102') r.expectDepartureTime = '0755';
  });
  const changedVerifier = sourceVerifier(
    python,
    async (url) => ({
      body: Buffer.from(JSON.stringify(changed)),
      file,
      url,
      at: '2026-10-21T00:00:00Z',
    }),
    '2026-10-21',
  );
  await assert.rejects(changedVerifier(group), /KHH official row changed/);
});
