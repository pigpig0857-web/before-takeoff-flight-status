import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { evaTableObservations } from '../scripts/automatic-verification/eva-public-table';
import br from '../src/server/data/kaohsiung-eva-flights.json';
import vn from '../src/server/data/kaohsiung-vietnam-flights.json';
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
const rows = [
  ...(br as CollectedSnapshot).records,
  ...(vn as CollectedSnapshot).records,
];
test('792 new KHH departures retain audited evidence and matching return routes', async () => {
  assert.equal(br.records.length, 573);
  assert.equal(vn.records.length, 219);
  const keys = new Set();
  for (const r of rows) {
    const f = normalizeCollected(r);
    assert.equal(f.origin, 'KHH');
    keys.add(`${r.date}|${r.number}|${r.airport}`);
    assert.equal(sha(await fs.readFile(r.evidence!.file)), r.evidence!.sha256);
    const found = findReturnFlights(
      new URLSearchParams({
        origin: r.airport!,
        destination: 'KHH',
        date: '2026-12-31',
        notBefore: r.arrival,
      }),
    );
    assert.ok(found.routeCollected);
    assert.ok(
      returns.records.some(
        (x) =>
          x.number.startsWith(r.number.slice(0, 2)) &&
          x.departureAirport === r.airport &&
          x.arrivalAirport === 'KHH',
      ),
    );
  }
  assert.equal(keys.size, 792);
  const before = JSON.parse(
    await fs.readFile(
      'data/flight-updates/khh-br-vn-integration-20261020/return-before.json',
      'utf8',
    ),
  );
  assert.deepEqual(returns.records.slice(0, 12306), before.records);
});
test('KHH BR/VN reject TPE evidence and unsupported routes', () => {
  for (const r of [rows[0], rows.at(-1)!]) {
    assert.throws(() =>
      normalizeCollected({
        ...r,
        evidence: {
          ...r.evidence!,
          query: { ...r.evidence!.query!, origin: 'TPE' },
        },
      }),
    );
    assert.throws(() => normalizeCollected({ ...r, airport: 'LAX' }));
  }
});
test('new source verification replays actual KHH data without querying TPE', async () => {
  for (const sample of [rows[0], rows.at(-1)!]) {
    const group = buildGroups([sample], {
      evaPublicForm: true,
      from: sample.date,
    })[0];
    if (sample.kind === 'collected_eva') {
      const parsed = JSON.parse(
        execFileSync(
          process.env.FLIGHT_VERIFICATION_PYTHON || 'python',
          [
            '-X',
            'utf8',
            'scripts/crawler/fetch-eva-form.py',
            '--parse-file',
            sample.evidence!.file,
          ],
          { encoding: 'utf8', windowsHide: true },
        ),
      );
      const observed = evaTableObservations(
        parsed.rows,
        sample.airport!,
        sample.date,
        '2026-12-31',
        'KHH',
      );
      assert.ok(
        observed.observations.some(
          (r) =>
            r.origin === 'KHH' &&
            r.number === sample.number &&
            r.departure === sample.departure &&
            r.arrival === sample.arrival,
        ),
      );
      assert.throws(() =>
        evaTableObservations(
          parsed.rows,
          sample.airport!,
          sample.date,
          '2026-12-31',
          'TPE',
        ),
      );
      continue;
    }
    const verify = sourceVerifier(
      '',
      async (url) => {
        assert.equal(
          new URL(url).searchParams.get('originLocationCode'),
          'KHH',
        );
        return {
          body: await fs.readFile(sample.evidence!.file),
          file: sample.evidence!.file,
          url,
          at: sample.fetchedAt,
        };
      },
      sample.date,
    );
    const result = await verify(group);
    assert.ok(
      result.rows.some(
        (r) =>
          r.origin === 'KHH' &&
          r.number === sample.number &&
          r.departure === sample.departure &&
          r.arrival === sample.arrival,
      ),
    );
  }
});
