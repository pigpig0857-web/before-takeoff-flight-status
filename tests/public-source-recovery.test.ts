import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { compareObservation } from '../scripts/automatic-verification/compare';
import vietnam from '../src/server/data/vietnam-flights.json';
import eva from '../src/server/data/eva-flights.json';
import type { CollectedSnapshot } from '../src/server/providers/collected';
import {
  buildGroups,
  sourceVerifier,
} from '../scripts/automatic-verification/sources';
import { fetchPublicSession } from '../scripts/automatic-verification/public-session';
import { vietnamPublicSegments } from '../scripts/automatic-verification/vietnam-public-segments';
const jejuURL = 'https://www.jejuair.net/en/prepare/flight/viewScheduleInfo.do';
test('A fresh anonymous public session follows only a bounded self-redirect that changes cookies', async () => {
  let calls = 0,
    proofs = 0;
  const jar = new Map<string, string>();
  const result = await fetchPublicSession(
    jejuURL,
    {},
    jar,
    async (response, hop) => {
      assert.equal(hop, 0);
      assert.equal(response.status, 302);
      proofs++;
    },
    (async (_url, options) => {
      calls++;
      if (calls === 1)
        return new Response('', {
          status: 302,
          headers: {
            location: '/en/prepare/flight/viewScheduleInfo.do',
            'set-cookie': 'session=anonymous; Secure; HttpOnly',
          },
        });
      assert.equal(
        (options!.headers as Record<string, string>).cookie,
        'session=anonymous',
      );
      return new Response('<title>Flight timetable</title>');
    }) as typeof fetch,
  );
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
  assert.equal(proofs, 1);
});
test('Public-session helper does not retry a denial, a redirect without a changed cookie, or a login redirect', async () => {
  for (const response of [
    new Response('', { status: 403 }),
    new Response('', { status: 302, headers: { location: jejuURL } }),
    new Response('', {
      status: 302,
      headers: {
        location: 'https://example.org/login',
        'set-cookie': 'session=anonymous',
      },
    }),
  ]) {
    let calls = 0;
    const result = await fetchPublicSession(
      jejuURL,
      {},
      new Map(),
      async () => assert.fail('No redirect is authorized'),
      (async () => {
        calls++;
        return response;
      }) as typeof fetch,
    );
    assert.equal(result.status, response.status);
    assert.equal(calls, 1);
  }
  await assert.rejects(
    fetchPublicSession(
      jejuURL,
      {},
      new Map(),
      async () => {},
      (async () => new Response('<title>Captcha</title>')) as typeof fetch,
    ),
    /challenge/,
  );
});
test('Vietnam adapter ignores future sample dates and confirms only explicitly published queried dates', async () => {
  const saved = (vietnam as CollectedSnapshot).records.find(
    (r) => r.date === '2026-10-18' && r.number === 'VN579',
  )!;
  const body = await readFile(
    'data/automatic-verification/recovery/vietnam-2026-10-14-system-ca/f514f1079e990db5f4a495ed.body',
  );
  let calls = 0;
  const verify = sourceVerifier(
    'unused',
    async (url) => {
      calls++;
      return { body, url, at: '2026-10-14T08:00:00Z', file: 'fixture.body' };
    },
    '2026-10-14',
  );
  const result = await verify(buildGroups([saved])[0]);
  assert.equal(calls, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].number, 'VN579');
  assert.equal(result.rows[0].date, '2026-10-18');
  assert.equal(result.rows[0].departure, saved.departure);
  assert.equal(result.rows[0].arrival, saved.arrival);
});
test('EVA form grouping preserves all existing identities while replacing thousands of expired detail links with bounded weekly queries', () => {
  const rows = (eva as CollectedSnapshot).records.filter(
    (r) => r.date >= '2026-10-14',
  );
  const before = JSON.stringify(rows),
    old = buildGroups(rows),
    fresh = buildGroups(rows, { evaPublicForm: true, from: '2026-10-14' });
  assert.ok(fresh.length < 600);
  assert.ok(old.length > 5000);
  assert.equal(
    fresh.reduce((n, g) => n + g.records.length, 0),
    rows.length,
  );
  assert.ok(
    fresh.every(
      (g) =>
        g.url.includes('flight-schedules.aspx') &&
        g.records.every((r) => r.airport === g.airport),
    ),
  );
  assert.equal(
    fresh.find(
      (g) =>
        g.airport === 'NRT' && g.records.some((r) => r.date === '2026-10-14'),
    )!.queryDate,
    '2026-10-14',
  );
  assert.equal(
    fresh.find(
      (g) =>
        g.airport === 'NRT' && g.records.some((r) => r.date === '2026-10-21'),
    )!.queryDate,
    '2026-10-24',
  );
  assert.equal(JSON.stringify(rows), before);
  assert.throws(() => buildGroups(rows, { evaPublicForm: true }), /explicit/);
});
test('Vietnam saved-response supplementation uses explicit dates and refuses weekday extrapolation or conflicting durations', async () => {
  const raw = JSON.parse(
    await readFile(
      'data/automatic-verification/recovery/vietnam-2026-10-14-system-ca/f514f1079e990db5f4a495ed.body',
      'utf8',
    ),
  );
  const rows = vietnamPublicSegments(raw, 'HAN');
  assert.deepEqual(
    rows.map((r) => r.date),
    ['2026-10-18', '2026-10-25'],
  );
  assert.equal(
    rows.some((r) => r.date === '2026-10-19'),
    false,
  );
  const wrong = structuredClone(raw);
  wrong.data.departureFlight.scheduleItems[0].connectedFlights[0].flightInfo.duration = 60;
  assert.throws(() => vietnamPublicSegments(wrong, 'HAN'));
});
test('The confirmed VN571 correction retains aircraft, terminals and dated evidence, with the new five-minute arrival difference', () => {
  const row = vietnam.records.find(
    (r) => r.date === '2026-10-25' && r.number === 'VN571',
  )!;
  assert.equal(row.departure, '2026-10-25T07:45:00+08:00');
  assert.equal(row.arrival, '2026-10-25T10:20:00+07:00');
  assert.equal(row.minutes, 215);
  assert.equal(row.terminal, 'T2');
  assert.equal(row.arrivalTerminal, '2');
  assert.equal(row.aircraft, 'AIRBUS A321');
  assert.equal(row.detail?.fetchedAt, row.fetchedAt);
  assert.ok(row.evidence.file.includes('vietnam-2026-10-14-system-ca'));
});
test('The new EVA automatic adapter replays the complete public form workflow and exact first-week flights', async () => {
  const root = 'data/source-samples/crawler/eva-recheck-2026-10-14',
    plan = JSON.parse(await readFile(root + '/progress.json', 'utf8'));
  const route = plan.routes.find((r: any) => r.airport === 'NRT'),
    observation = route.observations.find(
      (o: any) => o.queryDate === '2026-10-14',
    );
  assert.ok(observation);
  const formFile = (await readdir(root)).find(
    (f) => f.startsWith('NRT-') && f.endsWith('-form.html'),
  )!;
  const groups = buildGroups(
    (eva as CollectedSnapshot).records.filter((r) => r.date >= '2026-10-14'),
    { evaPublicForm: true, from: '2026-10-14' },
  );
  const group = groups.find(
    (g) => g.airport === 'NRT' && g.queryDate === '2026-10-14',
  )!;
  const requests: string[] = [];
  const verify = sourceVerifier(
    process.env.FLIGHT_PYTHON ||
      path.join(
        process.env.USERPROFILE || '',
        '.cache',
        'codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',
      ),
    async (url, _id, options = {}) => {
      requests.push(options.method || 'GET');
      const file = url.includes('getAirportCache.ashx')
        ? root + '/airports.xml'
        : options.method === 'POST'
          ? root + '/' + observation.file
          : root + '/' + formFile;
      if (options.method === 'POST') {
        assert.equal(options.body!.get('ctl00$content$hid_Dep'), 'TPETPE');
        assert.equal(options.body!.get('ctl00$content$hid_Arr'), route.value);
        assert.equal(
          options.body!.get('ctl00$content$txt_tbGo2YYYYMM'),
          group.queryDate,
        );
      }
      return {
        body: await readFile(file),
        url,
        file,
        at: observation.observedAt,
      };
    },
    '2026-10-14',
  );
  const result = await verify(group);
  assert.deepEqual(requests, ['GET', 'GET', 'POST']);
  const compared = compareObservation(
    group.records,
    result.rows,
    result.evidence.at,
    result.evidence.file,
    { version: 1, updatedAt: result.evidence.at, entries: {} },
  );
  assert.equal(compared.verified, 21);
  assert.equal(compared.changed, 0);
  assert.equal(compared.not_listed, 0);
});
test('The extra Chiang Mai departure is dated official data and does not invent aircraft or airport terminals', () => {
  const row = eva.records.find(
    (r) => r.number === 'BR1257' && r.date === '2026-11-24',
  )!;
  assert.ok(row);
  assert.equal(row.airport, 'CNX');
  assert.equal(row.departure, '2026-11-24T09:10:00+08:00');
  assert.equal(row.arrival, '2026-11-24T12:15:00+07:00');
  assert.equal(row.minutes, 245);
  assert.equal(row.aircraft, null);
  assert.equal(row.terminal, null);
  assert.equal(row.arrivalTerminal, null);
  assert.ok(row.evidence?.sha256);
});
