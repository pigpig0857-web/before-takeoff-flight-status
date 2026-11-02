import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCiTimetable,
  ciFlightsOnDate,
  type CiExtraction,
} from '../src/server/providers/experimental/ci-timetable';

// Minimal factual fixture: directional section and six operating-date rules.
const extraction: CiExtraction = {
  coverText: '2026.07.01 2026.10.24\nIssue 2',
  pages: 29,
  blocks: [
    {
      page: 4,
      text: [
        'TAIPEI SONGSHAN TOKYO HANEDA 3h10m',
        'CI 220 1234567 09:00-13:10 333 -',
        'TAIPEI TAOYUAN TOKYO NARITA 3h20m ~ 3h25m',
        'CI 100 1234567 08:50-13:15 EQV -',
        'CI 104 1234567 12:15-16:35 EQV -',
        'CI 108 1234567 14:35-19:00 32Q/333 -',
        'CI 106 1234567 16:25-20:50 32Q 01Jul26-31Jul26',
        'CI 106 123456 16:30-20:55 32Q 01Aug26-24Oct26',
        'CI 106 7 16:25-20:50 32Q 02Aug26-18Oct26',
        'CI 9902 (JL 802) 1234567 10:25-14:55 73H -',
        'CI 9958 (JL 8664) 1234567 12:45-17:15 76W -',
        'TAIPEI TAOYUAN OSAKA KANSAI 2h45m ~ 2h50m',
        'CI 156 1234567 08:15-12:00 EQV -',
      ].join('\n'),
    },
  ],
};

test('Crawler trial extracts only the Taoyuan outbound operating section', () => {
  const timetable = parseCiTimetable(extraction);
  assert.equal(timetable.rules.length, 6);
  assert.equal(timetable.skippedCodeshares, 2);
  assert.deepEqual(
    ciFlightsOnDate(timetable, '2026-10-20').map((f) => f.number),
    ['CI100', 'CI104', 'CI108', 'CI106'],
  );
  assert.ok(
    timetable.rules.every(
      (rule) => rule.number !== 'CI220' && rule.number !== 'CI156',
    ),
  );
});

test('Day-of-week and per-row validity select Sunday and seasonal flight times', () => {
  const timetable = parseCiTimetable(extraction);
  const ci106 = (date: string) =>
    ciFlightsOnDate(timetable, date).find((f) => f.number === 'CI106');
  assert.equal(ci106('2026-07-20')?.departureTime, '16:25');
  assert.equal(ci106('2026-10-18')?.departureTime, '16:25');
  assert.equal(ci106('2026-10-19')?.departureTime, '16:30');
  assert.equal(ci106('2026-10-25'), undefined);
});

test('Arrival uses Tokyo time and is validated against the independently printed duration', () => {
  const timetable = parseCiTimetable(extraction);
  const flight = ciFlightsOnDate(timetable, '2026-10-20')[0];
  assert.equal(flight.scheduledDeparture, '2026-10-20T08:50:00+08:00');
  assert.equal(flight.arrivalTime, '13:15');
  assert.equal(flight.scheduledArrival, '2026-10-20T04:15:00.000Z');
  assert.equal(flight.durationMinutes, 205);
  const wrong = {
    ...timetable,
    rules: timetable.rules.map((r) => ({ ...r, arrivalTime: '08:00' })),
  };
  assert.throws(() => ciFlightsOnDate(wrong, '2026-10-20'), /duration/);
});

test('Unpublished dates cannot be expanded into invented December flights', () => {
  const timetable = parseCiTimetable(extraction);
  assert.equal(ciFlightsOnDate(timetable, '2026-12-30').length, 0);
  assert.equal(ciFlightsOnDate(timetable, '2026-06-30').length, 0);
  assert.throws(() => ciFlightsOnDate(timetable, '2026-02-30'), /Invalid/);
});

test('Unsupported layout, malformed periods and duplicate active rules fail closed', () => {
  assert.throws(
    () => parseCiTimetable({ ...extraction, blocks: [] }),
    /missing/,
  );
  assert.throws(
    () => parseCiTimetable({ ...extraction, coverText: 'No dates' }),
    /validity/,
  );
  assert.throws(
    () =>
      parseCiTimetable({
        ...extraction,
        blocks: [
          {
            ...extraction.blocks[0],
            text: extraction.blocks[0].text.replace(
              '01Jul26-31Jul26',
              '01Jul26 / 31Jul26',
            ),
          },
        ],
      }),
    /exception/,
  );
  const timetable = parseCiTimetable(extraction);
  assert.throws(
    () =>
      ciFlightsOnDate(
        { ...timetable, rules: [...timetable.rules, timetable.rules[0]] },
        '2026-10-20',
      ),
    /Conflicting/,
  );
});
