import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import lion from '../src/server/data/thai-lion-flights.json';
import khhLion from '../src/server/data/kaohsiung-thai-lion-flights.json';
import returns from '../src/server/data/return-flights.json';
import {
  normalizeCollected,
  type CollectedSnapshot,
} from '../src/server/providers/collected';
import { findReturnFlights } from '../src/server/services/return-flights';
import {
  buildGroups,
  sourceVerifier,
  sha,
} from '../scripts/automatic-verification/sources';
const root = 'data/source-samples/crawler/thai-lion-20261020';
const read = async (p: string) => JSON.parse(await fs.readFile(p, 'utf8'));
const rows = [
  ...(lion as CollectedSnapshot).records,
  ...(khhLion as CollectedSnapshot).records,
];
test('Thai Lion imports 27 source-proven departures and 22 returns without changing existing data', async () => {
  assert.equal(lion.records.length, 10);
  assert.equal(khhLion.records.length, 17);
  const before = await read(root + '/integration/return-before.json');
  assert.deepEqual(returns.records.slice(0, 13103), before.records);
  assert.equal(returns.records.length, 13156);
  const baseline = await read(root + '/integration/before.json');
  for (const [file, digest] of Object.entries(baseline))
    if (file !== 'return-flights.json')
      assert.equal(sha(await fs.readFile('src/server/data/' + file)), digest);
  for (const row of rows) {
    const f = normalizeCollected(row);
    assert.equal(f.airlineCode, 'SL');
    assert.equal(f.origin, row.origin);
    assert.equal(
      sha(await fs.readFile(row.evidence!.file)),
      row.evidence!.sha256,
    );
    assert.ok(row.date <= '2026-10-31');
    assert.equal(row.terminal, null);
    assert.equal(row.aircraft, null);
    assert.equal(
      (Date.parse(row.arrival) - Date.parse(row.departure)) / 60000,
      row.minutes,
    );
  }
});
test('source conflicts stay outside new imports and existing SL393 remains unchanged', async () => {
  const conflicts = (await read(root + '/conflicts.json')).records;
  assert.equal(conflicts.length, 4);
  for (const c of conflicts) {
    assert.ok(c.observations.length > 1);
    assert.ok(
      !rows.some(
        (r) => [r.date, r.number, r.origin, r.airport].join('|') === c.identity,
      ),
    );
  }
  const c = conflicts.find(
    (r: any) => r.identity === '2026-10-21|SL393|CTS|KHH',
  );
  assert.ok(c.existing);
  assert.equal(
    returns.records.find(
      (r) => r.number === 'SL393' && r.date === '2026-10-21',
    )!.arrival,
    c.existing.arrival,
  );
});
test('Thai Lion October exceptions keep published local times and both Taiwan arrival airports', () => {
  const tpe = rows.find(
    (r) =>
      r.origin === 'TPE' && r.number === 'SL380' && r.date === '2026-10-26',
  )!;
  assert.equal(tpe.departure, '2026-10-26T09:00:00+08:00');
  assert.equal(tpe.arrival, '2026-10-26T11:15:00+09:00');
  const khh = rows.find(
    (r) =>
      r.origin === 'KHH' && r.number === 'SL390' && r.date === '2026-10-27',
  )!;
  assert.equal(khh.departure, '2026-10-27T11:10:00+08:00');
  assert.equal(khh.arrival, '2026-10-27T13:50:00+09:00');
  for (const destination of ['TPE', 'KHH']) {
    const result = findReturnFlights(
      new URLSearchParams({
        origin: 'OKA',
        destination,
        date: '2026-10-23',
        notBefore: '2026-10-20T11:00:00+09:00',
      }),
    );
    if (destination === 'TPE')
      assert.ok(result.flights.some((r) => r.airlineCode === 'SL'));
    assert.ok(result.flights.every((r) => r.arrivalAirport === destination));
  }
  assert.throws(() =>
    normalizeCollected({
      ...tpe,
      date: '2026-11-01',
      departure: '2026-11-01T09:00:00+08:00',
      arrival: '2026-11-01T11:15:00+09:00',
    }),
  );
});
test('background confirmation accepts unchanged publication and rejects changed bytes', async () => {
  for (const group of buildGroups(rows)) {
    const source = group.records[0];
    const download = async (url: string) => ({
      body: await fs.readFile(source.evidence!.file),
      file: source.evidence!.file,
      url,
      at: source.fetchedAt,
    });
    const result = await sourceVerifier('', download, '2026-10-20')(group);
    assert.equal(result.rows.length, group.records.length);
    await assert.rejects(
      sourceVerifier(
        '',
        async (url) => ({
          body: Buffer.from('{}'),
          file: 'changed',
          url,
          at: source.fetchedAt,
        }),
        '2026-10-20',
      )(group),
      /publication changed/,
    );
  }
});
