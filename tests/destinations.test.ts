import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDestination,
  arrivalAirport,
  arrivalCity,
  taoyuanAirports,
} from '../src/features/flights/destinations';
import served from '../src/features/flights/data/taoyuan-destinations.json';
import { airportNames } from '../src/features/flights/destination-aliases';
import { filterFlights, parseFilters } from '../src/features/flights/filter';
import type { Flight } from '../src/features/flights/types';

function flight(code: string, time: string, date = '2026-10-06'): Flight {
  return {
    id: `${code}-${time}-${date}`,
    number: 'BR198',
    airlineCode: 'BR',
    airline: '長榮航空',
    date,
    scheduledDeparture: `${date}T${time}:00+08:00`,
    reportedDeparture: null,
    reportedTimeKind: 'estimated',
    destinationCode: code,
    destination:
      code === 'HND' ? '羽田' : code === 'NRT' ? '東京／成田' : '大阪',
    destinationEnglish: '',
    terminal: 'T2',
    gate: null,
    counter: null,
    aircraft: null,
    status: 'scheduled',
    sourceStatus: '',
    source: 'schedule',
  };
}
const flights = [
  flight('NRT', '08:00'),
  flight('HND', '10:00'),
  flight('NRT', '12:00'),
  flight('KIX', '12:30'),
  flight('HND', '23:59'),
  flight('NRT', '09:00', '2026-10-07'),
];

test('Country + city and natural Chinese destination queries include both Tokyo airports', () => {
  for (const q of [
    '東京',
    '日本東京',
    '日本 東京',
    '我要去日本東京',
    '我想去東京',
    'Tokyo',
    'Japan Tokyo',
    'Ｔｏｋｙｏ',
  ]) {
    const filters = parseFilters(
      new URLSearchParams({ q, date: '2026-10-06' }),
      '2026-10-06',
    );
    assert.deepEqual(
      filterFlights(flights, filters).map((f) => f.destinationCode),
      ['NRT', 'HND', 'NRT', 'HND'],
      q,
    );
  }
});

test('Country selection intersects destination text and time, and clearing it restores all countries', () => {
  const samples = [
    flight('NRT', '08:00'),
    flight('ICN', '09:00'),
    flight('KIX', '10:00'),
    flight('BKK', '11:00'),
    flight('CNX', '12:00'),
  ];
  const search = (country: string, q = '', start = '00:00') =>
    filterFlights(
      samples,
      parseFilters(
        new URLSearchParams({ date: '2026-10-06', country, q, start }),
        '2026-10-06',
      ),
    ).map((f) => f.destinationCode);
  assert.deepEqual(search('JP'), ['NRT', 'KIX']);
  assert.deepEqual(search('jp', '東京'), ['NRT']);
  assert.deepEqual(search('JP', '', '10:00'), ['KIX']);
  assert.deepEqual(search('KR'), ['ICN']);
  assert.deepEqual(search('TH'), ['BKK', 'CNX']);
  assert.deepEqual(search('TH', '曼谷'), ['BKK']);
  assert.deepEqual(search('TH', '東京'), []);
  assert.deepEqual(search('TH', '長榮航空'), ['BKK', 'CNX']);
  assert.deepEqual(search(''), ['NRT', 'ICN', 'KIX', 'BKK', 'CNX']);
  assert.deepEqual(search('', '東京'), ['NRT']);
  assert.throws(() =>
    parseFilters(new URLSearchParams({ country: 'INVALID' }), '2026-10-06'),
  );
});

test('Airport-specific queries stay narrow even when source text also includes Tokyo', () => {
  for (const q of [
    '成田',
    'NRT',
    '成田國際機場',
    '東京／成田',
    '日本東京成田',
  ]) {
    const filters = parseFilters(
      new URLSearchParams({ q, date: '2026-10-06' }),
      '2026-10-06',
    );
    assert.deepEqual(
      filterFlights(flights, filters).map((f) => f.destinationCode),
      ['NRT', 'NRT'],
      q,
    );
  }
  assert.deepEqual(
    resolveDestination('羽田')?.airports.map((a) => a.code),
    ['HND'],
  );
  assert.equal(resolveDestination('日本')?.kind, 'country');
  assert.equal(
    filterFlights(
      flights,
      parseFilters(new URLSearchParams({ q: '日本東京大阪' }), '2026-10-06'),
    ).length,
    0,
  );
});

test('Korea, China, country aliases and country + city are destination searches, never airline searches', () => {
  const samples = [
    'ICN',
    'GMP',
    'PUS',
    'CJU',
    'TAE',
    'CJJ',
    'PVG',
    'SHA',
    'PEK',
    'CAN',
    'HKG',
    'MFM',
    'NRT',
    'HND',
    'KIX',
    'BKK',
    'DMK',
  ].map((code) => flight(code, '12:00'));
  const search = (q: string) =>
    filterFlights(
      samples,
      parseFilters(
        new URLSearchParams({ q, date: '2026-10-06' }),
        '2026-10-06',
      ),
    ).map((f) => f.destinationCode);
  for (const q of [
    '韓國',
    '南韓',
    '韩国',
    'Korea',
    'South Korea',
    '我要去韓國',
  ])
    assert.deepEqual(search(q), ['ICN', 'GMP', 'PUS', 'CJU', 'TAE', 'CJJ'], q);
  for (const q of ['中國', '中国', '中國大陸', '大陸', 'China'])
    assert.deepEqual(search(q), ['PVG', 'SHA', 'PEK', 'CAN'], q);
  assert.deepEqual(search('韓國首爾'), ['ICN', 'GMP']);
  assert.deepEqual(search('中國上海'), ['PVG', 'SHA']);
  assert.deepEqual(search('韓國仁川'), ['ICN']);
  assert.deepEqual(search('中國北京'), ['PEK']);
  assert.deepEqual(search('泰國曼谷'), ['BKK', 'DMK']);
  assert.deepEqual(search('日本'), ['NRT', 'HND', 'KIX']);
  assert.deepEqual(search('香港'), ['HKG']);
  assert.deepEqual(search('澳門'), ['MFM']);
  assert.deepEqual(search('韓國東京'), []);
});

test('Every official TPE departure destination has country, Chinese airport name, and searchable city', () => {
  assert.equal(taoyuanAirports.length, served.length);
  assert.ok(served.length >= 90);
  const samples = served.map((source) => ({
    ...flight(source.code, '12:00'),
    destination: source.city,
    destinationEnglish: source.english,
  }));
  for (const source of served) {
    const airport = arrivalAirport(source.code);
    assert.ok(airport, source.code);
    assert.match(airport.countryCode, /^[A-Z]{2}$/);
    assert.ok(
      airportNames[source.code],
      `Chinese airport name: ${source.code}`,
    );
    for (const q of [
      source.code,
      source.city,
      airport.country,
      `${airport.country}${source.city}`,
      `我要去${airport.country}${airport.city}`,
    ]) {
      const result = filterFlights(
        samples,
        parseFilters(new URLSearchParams({ q }), '2026-10-06'),
      );
      assert.ok(
        result.some((f) => f.destinationCode === source.code),
        `${source.code}: ${q}`,
      );
    }
    const countryResults = filterFlights(
      samples,
      parseFilters(new URLSearchParams({ q: airport.country }), '2026-10-06'),
    );
    assert.ok(
      countryResults.every(
        (f) =>
          arrivalAirport(f.destinationCode)?.countryCode ===
          airport.countryCode,
      ),
      source.code,
    );
  }
});

test('New TPE routes use directory country data and official local city text without a bespoke route alias', () => {
  const source = {
    ...flight('MAN', '15:00'),
    destination: '曼徹斯特',
    destinationEnglish: 'Manchester',
  };
  assert.equal(
    taoyuanAirports.some((airport) => airport.code === 'MAN'),
    false,
  );
  for (const q of ['英國', '英國曼徹斯特', '我要去英國曼徹斯特']) {
    assert.equal(
      filterFlights(
        [source],
        parseFilters(new URLSearchParams({ q, start: '15:00' }), '2026-10-06'),
      ).length,
      1,
      q,
    );
  }
  assert.equal(
    filterFlights(
      [source],
      parseFilters(new URLSearchParams({ q: '韓國曼徹斯特' }), '2026-10-06'),
    ).length,
    0,
  );
  assert.equal(
    filterFlights(
      [source],
      parseFilters(
        new URLSearchParams({ q: '英國', start: '15:01' }),
        '2026-10-06',
      ),
    ).length,
    0,
  );
});

test('From-time search includes the boundary through end of the selected Taiwan day only', () => {
  const filters = parseFilters(
    new URLSearchParams({ q: '日本東京', date: '2026-10-06', start: '10:00' }),
    '2026-10-06',
  );
  assert.deepEqual(
    filterFlights(flights, filters).map((f) =>
      f.scheduledDeparture.slice(11, 16),
    ),
    ['10:00', '12:00', '23:59'],
  );
  assert.deepEqual(
    filterFlights(flights, { ...filters, q: '' }).map((f) => f.destinationCode),
    ['HND', 'NRT', 'KIX', 'HND'],
  );
  assert.equal(
    filterFlights(flights, { ...filters, start: '23:59' }).length,
    1,
  );
});

test('Registered arrival codes display city and specific airport; unknown codes are not guessed', () => {
  assert.equal(arrivalCity('HND'), '東京');
  assert.equal(arrivalAirport('NRT')?.name, '成田國際機場');
  assert.equal(arrivalAirport('XXX'), undefined);
});
