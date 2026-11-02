import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import jeju from '../src/server/data/kaohsiung-jeju-flights.json';
import eva from '../src/server/data/eva-flights.json';
import starlux from '../src/server/data/starlux-flights.json';
import pr from '../src/server/data/philippine-flights.json';
import {
  normalizeCollected,
  type CollectedSnapshot,
} from '../src/server/providers/collected';
import { FlightJourneySummary } from '../src/frontend/flights/flight-journey-summary';
import { FlightDetails } from '../src/frontend/flights/flight-details';
import { FlightSourceNote } from '../src/frontend/flights/flight-source-note';
import type { Flight } from '../src/features/flights/types';
const flight = normalizeCollected(
  (jeju as CollectedSnapshot).records.find(
    (r) => r.number === '7C6122' && r.date === '2026-12-31',
  )!,
);
const summary = (f: Flight) =>
  renderToStaticMarkup(createElement(FlightJourneySummary, { flight: f }));
const details = (f: Flight) =>
  renderToStaticMarkup(
    createElement(FlightDetails, {
      flight: f,
      stale: false,
      onClose: () => {},
    }),
  );
const primary = (f: Flight) =>
  details(f).split('<details class="flight-extra-disclosure"')[0];
test('Primary summary labels Taiwan and Korean local dates, times and elapsed duration without unknown metadata', () => {
  const html = summary(flight);
  for (const value of [
    '台灣時間',
    '韓國當地時間',
    '2026/12/31',
    '14:15',
    '17:55',
    '2 小時 40 分鐘',
    '高雄',
    '金浦',
  ])
    assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /UTC|尚未取得|登機門|機型|行程|當地同日抵達/);
});

test('Arrival shows the same instant in destination and origin time with explicit place and date', () => {
  const html = summary(flight);
  assert.match(html, /抵達 · 韓國當地時間/);
  assert.match(html, /17:55/);
  const origin = html
    .split('class="flight-arrival-origin"')[1]!
    .split('</div>')[0];
  assert.match(origin, /抵達時的台灣時間/);
  assert.match(origin, /高雄 KHH · 台灣時間/);
  assert.match(origin, /2026\/12\/31/);
  assert.match(origin, /16:55/);
  const japan = summary({
    ...flight,
    origin: 'TPE',
    destination: '東京',
    destinationCode: 'NRT',
    arrivalTimeZone: 'Asia/Tokyo',
    date: '2026-10-21',
    scheduledDeparture: '2026-10-21T02:00:00+08:00',
    scheduledArrival: '2026-10-21T06:30:00+09:00',
  });
  assert.match(japan, /日本當地時間/);
  assert.match(japan, /06:30/);
  assert.match(japan, /桃園 TPE · 台灣時間/);
  assert.match(japan, /05:30/);
});

test('Origin conversion preserves a different calendar day and handles equal time zones', () => {
  const us = summary({
    ...flight,
    destinationCode: 'LAX',
    arrivalTimeZone: 'America/Los_Angeles',
    scheduledArrival: '2026-12-30T19:10:00-08:00',
  });
  assert.match(us, /2026\/12\/30/);
  assert.match(us, /19:10/);
  const origin = us
    .split('class="flight-arrival-origin"')[1]!
    .split('</div>')[0];
  assert.match(origin, /2026\/12\/31/);
  assert.match(origin, /11:10/);
  const manila = summary({
    ...flight,
    destinationCode: 'MNL',
    arrivalTimeZone: 'Asia/Manila',
    scheduledArrival: '2027-01-01T00:20:00+08:00',
  });
  assert.match(manila, /菲律賓當地時間/);
  assert.equal((manila.match(/2027\/01\/01/g) || []).length, 2);
  assert.equal((manila.match(/00:20<\//g) || []).length, 2);
});
test('Main dialog puts timetable ahead of source evidence and keeps optional tools in a closed disclosure', () => {
  const html = details(flight),
    visible = primary(flight);
  assert.match(visible, /14:15/);
  assert.match(visible, /查看來源/);
  assert.doesNotMatch(
    visible,
    /修改抵達時間|複製航班摘要|你的下一步|報到櫃台|班表來源核對時間|原資料取得|UTC/,
  );
  assert.match(html, /<details class="flight-extra-disclosure">/);
  assert.match(html, /修改抵達時間/);
  assert.match(html, /查看班表來源/);
});
test('Material uncertainty and onward segment restrictions remain outside optional details', () => {
  const f: Flight = {
    ...flight,
    timetableVerification: {
      state: 'changed',
      attemptedAt: '2026-10-16T02:00:00Z',
    },
  };
  assert.match(primary(f), /時間待確認/);
  assert.match(primary(f), /本次來源起降時間與保存資料不同/);
  const continued: Flight = {
    ...flight,
    collected: { ...flight.collected!, continuationAirport: 'NRT' },
  };
  assert.match(primary(continued), /直飛區段/);
  assert.match(primary(continued), /不含該續程/);
});
test('Previous-day US arrivals, next-day European arrivals and year rollover retain local dates', () => {
  const rows = [
    ...(eva as CollectedSnapshot).records,
    ...(starlux as CollectedSnapshot).records,
  ];
  const previous = rows.find(
    (r) =>
      ['LAX', 'SFO', 'SEA', 'JFK'].includes(r.airport || '') &&
      r.arrival.slice(0, 10) < r.date,
  )!;
  const next = rows.find(
    (r) =>
      ['LHR', 'CDG', 'AMS', 'VIE', 'MUC', 'MXP'].includes(r.airport || '') &&
      r.arrival.slice(0, 10) > r.date,
  )!;
  assert.ok(previous);
  assert.ok(next);
  for (const row of [previous, next]) {
    const html = summary(normalizeCollected(row));
    assert.ok(html.includes(row.arrival.slice(0, 10).replaceAll('-', '/')));
    assert.match(html, /flight-day-change/);
  }
  const rollover = (pr as CollectedSnapshot).records.find(
    (r) => r.number === 'PR895' && r.date === '2026-12-31',
  )!;
  assert.match(summary(normalizeCollected(rollover)), /2027\/01\/01/);
});
test('Published terminal labels remain visible; missing arrivals never get invented times or durations', () => {
  const known = { ...flight, terminal: 'INT', arrivalTerminal: '3' };
  assert.match(summary(known), /國際線航廈/);
  assert.match(summary(known), /第三航廈/);
  const absent = summary({ ...flight, scheduledArrival: null });
  assert.match(absent, /抵達時間待確認/);
  assert.doesNotMatch(
    absent,
    /flight-duration-summary|flight-arrival-origin|17:55/,
  );
});
test('Compact source footer distinguishes original retrieval from actual verification', () => {
  const note = (f: Flight) =>
    renderToStaticMarkup(
      createElement(FlightSourceNote, { flight: f, compact: true }),
    );
  assert.match(note(flight), /資料取得/);
  assert.match(
    note({
      ...flight,
      timetableVerification: {
        state: 'verified',
        attemptedAt: flight.collected!.fetchedAt,
        verifiedAt: flight.collected!.fetchedAt,
      },
    }),
    /最近核對/,
  );
});
