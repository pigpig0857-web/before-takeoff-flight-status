import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEvaDetail } from '../scripts/crawler/eva-detail';

const text =
  'Flight details BR075Operated By：EVA AIR Nov. 26, 2026 07:40 TAIPEI TAIPEI (TAOYUAN) Terminal 2 10:45 BANGKOK BANGKOK Flight Time 4 Hours 5 Minutes 787-10 seat maps Please click the link below to read more.';
const expected = {
  number: 'BR75',
  date: '2026-11-26',
  departureTime: '07:40',
  arrivalTime: '10:45',
  arrivalDayOffset: 0,
  minutes: 245,
  arrivalLabel: 'BANGKOK BANGKOK',
};
test('Source detail retains exact-date terminals and aircraft without inventing an absent arrival terminal', () => {
  assert.deepEqual(parseEvaDetail(text, expected), {
    departureTerminal: 'T2',
    arrivalTerminal: null,
    aircraft: '787-10',
    operator: '長榮航空',
    minutes: 245,
    nonstop: true,
    scope: 'segment',
  });
  assert.equal(
    parseEvaDetail(
      text.replace(
        'BANGKOK BANGKOK Flight',
        'BANGKOK BANGKOK Terminal Intl. Flight',
      ),
      expected,
    ).arrivalTerminal,
    'Intl.',
  );
});
test('Stale detail, changed times, wrong airport, other operator and multiple segments are quarantined', () => {
  for (const bad of [
    text.replace('BR075', 'BR067'),
    text.replace('Nov. 26', 'Nov. 25'),
    text.replace('07:40', '07:30'),
    text.replace('10:45', '10:40'),
    text.replace('BANGKOK BANGKOK', 'TOKYO TOKYO (NARITA)'),
    text.replace('EVA AIR', 'Other Airline'),
    text.replace('4 Hours', '3 Hours'),
    text + ' Flight Time 10 Hours',
  ])
    assert.throws(() => parseEvaDetail(bad, expected));
});
test('Overnight arrival offset and singular Hour notation are verified', () => {
  const next = text
    .replace('10:45', '10:45+1')
    .replace('4 Hours 5 Minutes', '1 Hour 5 Minutes');
  assert.equal(
    parseEvaDetail(next, { ...expected, arrivalDayOffset: 1, minutes: 65 })
      .minutes,
    65,
  );
  assert.throws(() => parseEvaDetail(next, expected));
});
