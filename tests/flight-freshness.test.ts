import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { flightHasStaleData } from '../src/features/flights/result-state';
import { FlightSourceNote } from '../src/frontend/flights/flight-source-note';
import {
  normalizeCollected,
  type SavedFlight,
} from '../src/server/providers/collected';
import type { FeedInfo } from '../src/features/flights/types';
import eva from '../src/server/data/eva-flights.json';
const now = Date.parse('2026-10-13T04:00:00Z');
const fresh = normalizeCollected({
  ...eva.records.find((r) => r.date === '2026-11-26' && r.airport === 'NRT')!,
  fetchedAt: '2026-10-13T02:00:00Z',
} as SavedFlight);
const feed: FeedInfo = {
  kind: 'collected_eva',
  label: '長榮',
  url: fresh.collected!.url,
  state: 'stale',
  fetchedAt: '2026-10-08T03:00:00Z',
  sourceUpdatedAt: null,
  dates: [fresh.date],
  warning: '部分資料超過一天',
  partial: true,
};
test('A freshly checked EVA row is not aged by older rows in the same airline feed', () => {
  assert.equal(flightHasStaleData(fresh, [feed], now), false);
  assert.equal(
    flightHasStaleData(
      {
        ...fresh,
        collected: { ...fresh.collected!, fetchedAt: '2026-10-08T03:00:00Z' },
      },
      [feed],
      now,
    ),
    true,
  );
});
test('Unavailable own source and stale inherited arrival still need confirmation', () => {
  assert.equal(
    flightHasStaleData(fresh, [{ ...feed, state: 'unavailable' }], now),
    true,
  );
  const live = {
    ...fresh,
    source: 'realtime' as const,
    collected: { ...fresh.collected!, fetchedAt: '2026-10-08T03:00:00Z' },
  };
  assert.equal(
    flightHasStaleData(
      live,
      [{ ...feed, kind: 'realtime', state: 'ready' }],
      now,
    ),
    true,
  );
});
test('Exactly 24 hours remains recent, later or missing timestamps require review', () => {
  const f = {
    ...fresh,
    collected: { ...fresh.collected!, fetchedAt: '2026-10-12T04:00:00Z' },
  };
  assert.equal(flightHasStaleData(f, [], now), false);
  assert.equal(flightHasStaleData(f, [], now + 1), true);
  assert.equal(
    flightHasStaleData(
      { ...f, collected: { ...f.collected, fetchedAt: 'invalid' } },
      [],
      now,
    ),
    true,
  );
});
test('A card shows its own timetable timestamp and identifies the saved source as non-live', () => {
  const today = new Date().toISOString();
  const html = renderToStaticMarkup(
    createElement(FlightSourceNote, {
      flight: {
        ...fresh,
        collected: { ...fresh.collected!, fetchedAt: today },
      },
    }),
  );
  assert.ok(html.includes('預定班表 · 非即時動態'));
  assert.ok(html.includes('班表'));
  assert.ok(html.includes(`dateTime="${today}"`));
  assert.ok(html.includes('台灣時間'));
  assert.ok(!html.includes('超過一天未重新核對'));
  const older = renderToStaticMarkup(
    createElement(FlightSourceNote, {
      flight: {
        ...fresh,
        collected: { ...fresh.collected!, fetchedAt: '2020-01-01T00:00:00Z' },
      },
    }),
  );
  assert.ok(older.includes('超過一天未重新核對'));
});
