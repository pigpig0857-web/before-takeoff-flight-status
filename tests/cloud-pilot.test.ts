import test from 'node:test';
import assert from 'node:assert/strict';
// JavaScript entry points are also used directly in the Cloud Run container.
import {
  pilotConfig,
  verifyPilotResult,
} from '../scripts/cloud/pilot-config.mjs';
import { Storage } from '../scripts/cloud/storage.mjs';

const now = new Date('2026-10-08T17:00:00Z');
test('cloud pilot uses Taipei tomorrow and a separate observation directory', () => {
  const config = pilotConfig({ STORAGE_BUCKET: 'flight-test-bucket' }, now);
  assert.equal(config.date, '2026-10-10');
  assert.deepEqual(config.airports, ['NRT']);
  assert.match(
    config.directory,
    /^data\/source-samples\/crawler\/cloud-pilot\//,
  );
});
test('storage refuses an existing run lock instead of overwriting it', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://metadata.google.internal/'))
      return Response.json({ access_token: 'test-token', expires_in: 3600 });
    assert.equal(
      new URL(String(url)).searchParams.get('ifGenerationMatch'),
      '0',
    );
    assert.equal(
      (options?.headers as Record<string, string>).Authorization,
      'Bearer test-token',
    );
    return new Response('', { status: 412 });
  };
  await assert.rejects(
    new Storage('flight-test-bucket').put('eva-pilot/control/run.lock', '{}'),
    /HTTP 412/,
  );
});
test('storage failures propagate and locks are released with the acquired generation', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://metadata.google.internal/'))
      return Response.json({ access_token: 'test-token', expires_in: 3600 });
    if (options?.method === 'DELETE') {
      assert.equal(
        new URL(String(url)).searchParams.get('ifGenerationMatch'),
        '123',
      );
      return new Response(null, { status: 204 });
    }
    return new Response('', { status: 403 });
  };
  const storage = new Storage('flight-test-bucket');
  await assert.rejects(storage.put('report.json', '{}'), /HTTP 403/);
  await storage.release('eva-pilot/control/run.lock', '123');
});
test('cloud pilot rejects invalid, historical, excessive and unreviewed scopes', () => {
  for (const change of [
    { PILOT_DATE: '2026-02-30' },
    { PILOT_DATE: '2026-10-08' },
    { PILOT_DATE: '2027-01-01' },
    { PILOT_AIRPORTS: 'NRT,NRT' },
    { PILOT_AIRPORTS: 'HND' },
    { STORAGE_BUCKET: '../bad' },
  ]) {
    assert.throws(() =>
      pilotConfig({ STORAGE_BUCKET: 'flight-test-bucket', ...change }, now),
    );
  }
});
test('cloud completion rejects partial results, wrong dates and other carriers', () => {
  const receipt = {
    status: 'verified_requested_scope',
    query: { departure: 'TPE', arrival: 'NRT', date: '2026-10-10' },
  };
  const record = {
    departure: 'TPE',
    arrival: 'NRT',
    departureLocal: '2026-10-10T08:50:00+08:00',
    marketingAirline: 'BR',
    number: 'BR198',
  };
  const analysis = {
    departure: 'TPE',
    arrival: 'NRT',
    queryDate: '2026-10-10',
    scope: 'requested_date',
    completeRequestedScope: true,
    scopeEntries: 1,
    verifiedDetails: 1,
    records: [record],
  };
  assert.equal(verifyPilotResult(receipt, analysis, 'NRT', '2026-10-10'), 1);
  for (const change of [
    { verifiedDetails: 0 },
    { completeRequestedScope: false },
    { records: [] },
    { records: [{ ...record, departureLocal: '2026-10-11T08:50:00+08:00' }] },
    { records: [{ ...record, number: 'CI100' }] },
  ]) {
    assert.throws(() =>
      verifyPilotResult(
        receipt,
        { ...analysis, ...change },
        'NRT',
        '2026-10-10',
      ),
    );
  }
});
