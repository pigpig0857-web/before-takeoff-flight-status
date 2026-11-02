import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import mm from '../src/server/data/kaohsiung-peach-flights.json';
import gk from '../src/server/data/kaohsiung-jetstar-flights.json';
import tpeMM from '../src/server/data/peach-flights.json';
import tpeGK from '../src/server/data/jetstar-flights.json';
import {
  normalizeCollected,
  type CollectedSnapshot,
} from '../src/server/providers/collected';
import { enrichPeachFlight } from '../src/server/providers/peach-enrichment';
import { verificationKey } from '../src/server/services/timetable-verification';
import { filterFlights } from '../src/features/flights/filter';
import { terminalLabel } from '../src/features/flights/terminal';
import { FlightDetails } from '../src/features/flights/flight-details';
import {
  buildGroups,
  sourceVerifier,
  sha,
} from '../scripts/automatic-verification/sources';
const peach = (mm as CollectedSnapshot).records,
  jetstar = (gk as CollectedSnapshot).records;
const all = [...peach, ...jetstar];
test('167 reviewed KHH PDF rows retain evidence, local times, unique identities and unknown aircraft', async () => {
  assert.equal(peach.length, 78);
  assert.equal(jetstar.length, 89);
  assert.equal(new Set(all.map(verificationKey)).size, 167);
  for (const rows of [peach, jetstar])
    assert.equal(new Set(rows.map((r) => r.date)).size, 78);
  for (const r of all) {
    const f = normalizeCollected(r);
    assert.equal(f.origin, 'KHH');
    assert.equal(r.aircraft, null);
    assert.equal(f.gate, null);
    assert.equal(f.counter, null);
    assert.equal(
      (Date.parse(r.arrival) - Date.parse(r.departure)) / 60000,
      r.minutes,
    );
    assert.equal(sha(await fs.readFile(r.evidence!.file)), r.evidence!.sha256);
    assert.notEqual(
      verificationKey(r),
      verificationKey({ ...r, origin: 'TPE' }),
    );
  }
});
test('Peach switches at winter boundary without importing old one-off flights or TPE metadata', () => {
  const summer = peach.find((r) => r.date === '2026-10-24')!,
    winter = peach.find((r) => r.date === '2026-10-25')!;
  assert.equal(summer.departure.slice(11, 16), '14:10');
  assert.equal(summer.minutes, 185);
  assert.equal(winter.departure.slice(11, 16), '14:20');
  assert.equal(winter.minutes, 165);
  assert.deepEqual(new Set(peach.map((r) => r.number)), new Set(['MM032']));
  for (const r of peach) {
    const f = normalizeCollected(r);
    assert.equal(enrichPeachFlight(f), f);
    assert.equal(r.terminal, null);
    assert.equal(f.airportGuidance, undefined);
  }
});
test('GK18 December split and GK98 start/day rules preserve published availability', () => {
  assert.equal(jetstar.filter((r) => r.number === 'GK18').length, 78);
  const okinawa = jetstar.filter((r) => r.number === 'GK98');
  assert.equal(okinawa.length, 11);
  for (const r of okinawa) {
    assert.ok(r.date >= '2026-12-06');
    assert.ok([0, 3, 5].includes(new Date(r.date + 'T12:00Z').getUTCDay()));
    assert.equal(r.minutes, 100);
  }
  for (const [date, time] of [
    ['2026-12-05', '14:00'],
    ['2026-12-06', '15:10'],
    ['2026-12-07', '14:00'],
    ['2026-12-11', '15:10'],
  ])
    assert.equal(
      jetstar
        .find((r) => r.number === 'GK18' && r.date === date)!
        .departure.slice(11, 16),
      time,
    );
  for (const date of ['2026-12-05', '2026-12-07'])
    assert.ok(!okinawa.some((r) => r.date === date));
});
test('KHH filters and shared cards display international and third terminals without TPE labels', () => {
  const flights = all.map(normalizeCollected);
  for (const q of ['樂桃', '捷星日本航空']) {
    const rows = filterFlights(flights, {
      origin: 'KHH',
      date: '2026-12-06',
      q,
      start: '00:00',
      end: '23:59',
      status: '',
    });
    assert.equal(rows.length, q === '樂桃' ? 1 : 2);
  }
  assert.equal(terminalLabel('T1'), '第一航廈');
  assert.equal(terminalLabel('3'), '第三航廈');
  assert.equal(terminalLabel('INT'), '國際線航廈');
  assert.equal(terminalLabel('Intl.'), '國際線航廈');
  assert.equal(terminalLabel('4'), '4');
  for (const airport of ['NRT', 'OKA']) {
    const flight = normalizeCollected(
      jetstar.find((r) => r.airport === airport)!,
    );
    const html = renderToStaticMarkup(
      createElement(FlightDetails, { flight, stale: false, onClose: () => {} }),
    );
    assert.match(html, /國際線航廈/);
    assert.doesNotMatch(html, /第二航廈|桃園|taoyuan-airport/);
    if (airport === 'NRT') assert.match(html, /第三航廈/);
  }
});
test('TPE and KHH PDF groups share each source response; changed PDFs are rejected', async () => {
  const records = [
    ...(tpeMM as CollectedSnapshot).records,
    ...(tpeGK as CollectedSnapshot).records,
    ...all,
  ].filter((r) => r.date >= '2026-10-15');
  const groups = buildGroups(records).filter(g => ['collected_peach', 'collected_jetstar'].includes(g.kind));
  const calls = new Map<string, number>();
  const urls = [...new Set(all.map((r) => r.url))];
  const verifier = sourceVerifier(
    '',
    async (url) => {
      calls.set(url, (calls.get(url) || 0) + 1);
      const row = all.find((r) => r.url === url);
      return {
        body: row
          ? await fs.readFile(row.evidence!.file)
          : Buffer.from(urls.map((u) => new URL(u).pathname).join('\n')),
        file: row?.evidence!.file || 'offline-index',
        at: all[0].fetchedAt,
        url,
      };
    },
    '2026-10-15',
  );
  for (const group of groups)
    assert.equal((await verifier(group)).rows.length, group.records.length);
  for (const url of urls) assert.equal(calls.get(url), 1);
  const rejected = sourceVerifier(
    '',
    async (url) => ({
      body: Buffer.from(
        urls.includes(url)
          ? 'changed'
          : urls.map((u) => new URL(u).pathname).join('\n'),
      ),
      file: 'offline',
      at: all[0].fetchedAt,
      url,
    }),
    '2026-10-15',
  );
  await assert.rejects(rejected(groups[0]), /PDF changed/);
});
