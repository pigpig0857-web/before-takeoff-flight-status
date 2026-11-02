import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import eva from '../src/server/data/eva-flights.json';
import { normalizeCollected, type SavedFlight } from '../src/server/providers/collected';
import { FlightCard } from '../src/frontend/flights/flight-card';

test('source unavailable allows saved outbound planning; uncertain changes and cancellation remain blocked', () => {
  const flight = normalizeCollected(eva.records.find((r) => r.number === 'BR178') as SavedFlight);
  for (const [state, disabled] of [['query_failed', false], ['verified', false], ['changed', true], ['not_listed', true], ['needs_review', true]] as const) {
    const html = renderToStaticMarkup(createElement(FlightCard, {
      flight: {...flight, timetableVerification: {state, attemptedAt:'2026-10-19T00:00:00Z'}},
      onSelect: () => {}, onChoose: () => {},
    }));
    const button = html.match(/<button[^>]*class="choose-outbound"[^>]*>/)![0];
    assert.equal(button.includes('disabled'), disabled, state);
    if (state === 'query_failed') assert.match(html, /來源暫時無法完成最新核對/);
  }
  for (const change of [{status:'cancelled' as const}, {scheduledArrival:null}, {destinationCode:''}]) {
    const html = renderToStaticMarkup(createElement(FlightCard, {flight:{...flight,...change}, onSelect:()=>{}, onChoose:()=>{}}));
    assert.match(html.match(/<button[^>]*class="choose-outbound"[^>]*>/)![0], /disabled/);
  }
});
