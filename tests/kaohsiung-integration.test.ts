import khhLion from '../src/server/data/kaohsiung-thai-lion-flights.json';
import khhExpanded from '../src/server/data/kaohsiung-expanded-flights.json';
import khhBR from '../src/server/data/kaohsiung-eva-flights.json';
import khhVN from '../src/server/data/kaohsiung-vietnam-flights.json';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import khh from '../src/server/data/kaohsiung-flights.json';
import tiger from '../src/server/data/tigerair-flights.json';
import khhMM from '../src/server/data/kaohsiung-peach-flights.json';
import khhGK from '../src/server/data/kaohsiung-jetstar-flights.json';
import khh7C from '../src/server/data/kaohsiung-jeju-flights.json';
import {
  collectedDataset,
  normalizeCollected,
  mergeCollectedFlights,
  type CollectedSnapshot,
} from '../src/server/providers/collected';
import { filterFlights, parseFilters } from '../src/features/flights/filter';
import {
  verificationFingerprint,
  verificationKey,
} from '../src/server/services/timetable-verification';
import { getFlightDataset } from '../src/server/services/flights';
import {
  buildGroups,
  sourceVerifier,
  sha,
} from '../scripts/automatic-verification/sources';
import { FlightDetails } from '../src/features/flights/flight-details';
import { FlightCard } from '../src/features/flights/flight-card';
import { FutureTripPanel } from '../src/features/flights/future-trip-panel';
import { DestinationHint } from '../src/features/flights/destination-hint';
const saved = khh as CollectedSnapshot;
const flights = collectedDataset(saved, '2026-10-15').flights;
const filters = {
  date: '2026-12-31',
  q: '',
  start: '00:00',
  end: '23:59',
  status: '',
};
test('KHH contains 637 unique departures over 78 dates and 14 reviewed destinations', async () => {
  assert.equal(flights.length, 637);
  assert.equal(new Set(flights.map((f) => f.id)).size, 637);
  assert.equal(new Set(flights.map((f) => f.date)).size, 78);
  assert.equal(new Set(flights.map((f) => f.destinationCode)).size, 14);
  assert.deepEqual(
    new Set(saved.records.map((r) => r.countryCode)),
    new Set(['JP', 'KR', 'VN']),
  );
  for (const r of saved.records) {
    assert.equal(r.origin, 'KHH');
    assert.equal(r.kind, 'collected_tigerair');
    assert.equal(r.aircraft, null);
    assert.equal(r.terminal, null);
    assert.equal(
      (Date.parse(r.arrival) - Date.parse(r.departure)) / 60000,
      r.minutes,
    );
  }
  const proof = saved.records[0].evidence!;
  assert.equal(sha(await fs.readFile(proof.file)), proof.sha256);
  assert.equal(collectedDataset(saved, '2027-01-01').flights.length, 0);
});
test('Origin filter is explicit and cannot mix TPE with KHH; unsupported airports are rejected', () => {
  assert.equal(filterFlights(flights, filters).length, 0);
  const khhResults = filterFlights(flights, { ...filters, origin: 'KHH' });
  assert.ok(
    khhResults.length > 0 && khhResults.every((f) => f.origin === 'KHH'),
  );
  assert.ok(
    filterFlights(flights, { ...filters, origin: 'KHH', q: '日本' }).every(
      (f) => f.collected!.countryCode === 'JP',
    ),
  );
  assert.equal(
    parseFilters(new URLSearchParams('origin=KHH'), '2026-10-15').origin,
    'KHH',
  );
  assert.throws(() =>
    parseFilters(new URLSearchParams('origin=TSA'), '2026-10-15'),
  );
  assert.throws(() =>
    parseFilters(new URLSearchParams('origin='), '2026-10-15'),
  );
});
test('Verification and merge identities distinguish departures while retaining every legacy TPE key', () => {
  const r = saved.records[0],
    tpe = { ...r, origin: 'TPE' as const };
  assert.notEqual(verificationKey(r), verificationKey(tpe));
  assert.equal(
    verificationKey(tpe),
    verificationKey({ ...tpe, origin: undefined }),
  );
  assert.equal(
    verificationFingerprint(tpe),
    verificationFingerprint({ ...tpe, origin: undefined }),
  );
  const a = normalizeCollected(r),
    b = { ...a, origin: 'TPE' as const, id: 'test-tpe' };
  assert.equal(mergeCollectedFlights([b], [a]).length, 2);
  assert.notEqual(a.id, normalizeCollected(tpe).id);
});
test('Both Tigerair departure airports share one response but verify separate rows and groups', async () => {
  const tpe = (tiger as CollectedSnapshot).records.filter(
    (r) => r.date >= '2026-10-15',
  );
  const groups = buildGroups([...tpe, ...saved.records]);
  assert.equal(groups.length, 2);
  let requests = 0;
  const proof = saved.records[0].evidence!,
    bytes = await fs.readFile(proof.file);
  const verifier = sourceVerifier(
    '',
    async (url) => {
      requests++;
      return {
        body: bytes,
        file: proof.file,
        at: saved.records[0].fetchedAt,
        url,
      };
    },
    '2026-10-15',
  );
  for (const group of groups) {
    const result = await verifier(group);
    assert.equal(result.rows.length, group.records.length);
    for (const row of group.records) {
      const found = result.rows.find(
        (r) => verificationKey(r) === verificationKey(row),
      )!;
      assert.ok(found);
      assert.equal(found.departure, row.departure);
      assert.equal(found.arrival, row.arrival);
    }
  }
  assert.equal(requests, 1);
});
test('KHH query service uses only KHH saved data and does not fetch Taoyuan feeds', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Unexpected network request');
  };
  try {
    const data = await getFlightDataset('KHH');
    assert.equal(data.origin, 'KHH');
    assert.equal(
      data.flights.length,
      [khh, khhMM, khhGK, khh7C, khhBR, khhVN, khhLion, khhExpanded].reduce(
        (n, s) => n + s.records.filter((r) => r.date >= data.today).length,
        0,
      ),
    );
    assert.ok(data.flights.every((f) => f.origin === 'KHH'));
    assert.equal(
      data.feeds.length,
      8 + khhLion.coverage.length + khhExpanded.coverage.length,
    );
    assert.ok(data.feeds.every((f) => f.partial));
    assert.match(data.warnings.join(''), /並非全部航空公司或即時航班/);
  } finally {
    globalThis.fetch = original;
  }
});
test('KHH cards and instructions use Kaohsiung names and official links without Taoyuan guidance', () => {
  const f = flights.find((f) => f.date === '2026-12-31')!;
  for (const html of [
    renderToStaticMarkup(
      createElement(FlightCard, { flight: f, onSelect: () => {} }),
    ),
    renderToStaticMarkup(
      createElement(FlightDetails, {
        flight: f,
        stale: false,
        onClose: () => {},
      }),
    ),
  ]) {
    assert.match(html, /高雄/);
    assert.match(html, /KHH/);
    assert.doesNotMatch(html, /桃園|taoyuan-airport/);
  }
  const html = renderToStaticMarkup(
    createElement(FlightDetails, {
      flight: f,
      stale: false,
      onClose: () => {},
    }),
  );
  assert.match(html, /https:\/\/www.kia.gov.tw\//);
  assert.match(html, /台灣時間/);
  assert.match(html, /當地時間/);
  const future = renderToStaticMarkup(
    createElement(FutureTripPanel, {
      filters: { ...filters, origin: 'KHH', date: '2027-01-01' },
    }),
  );
  assert.match(future, /高雄國際機場 KHH/);
  assert.doesNotMatch(future, /出發機場：桃園|桃園國際機場/);
});
test('Empty KHH city results do not advertise airports from the Taoyuan route directory', () => {
  const html = renderToStaticMarkup(
    createElement(DestinationHint, {
      origin: 'KHH',
      query: '紐約',
      flights: [],
      selectedAirport: null,
      onToggleAirport: () => {},
    }),
  );
  assert.doesNotMatch(html, /JFK|EWR/);
});
