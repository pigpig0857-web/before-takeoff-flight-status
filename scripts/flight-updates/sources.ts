import assert from 'node:assert/strict';
import type {
  CollectedSnapshot,
  SavedFlight,
} from '../../src/server/providers/collected';
import { arrivalAirport } from '../../src/features/flights/destinations';
import { validDate } from '../../src/lib/time';
import {
  analyzeEvaWeek,
  planEvaHttpDetails,
  EVA_SCHEDULE_URL,
  type EvaWeek,
  type EvaDetail,
} from '../../src/server/providers/experimental/eva-schedule';
import { validateSnapshot, type ObservationScope } from './compare';

export interface PeachSource {
  id: string;
  from: string;
  to: string;
  url: string;
  file: string;
  sha256: string;
  fetchedAt: string;
  publishedAt?: string;
  repeatHashMatches: boolean;
  repeatedSha256?: string;
}
export interface PeachReceipt {
  version: number;
  status: string;
  departureAirport: string;
  indexUrl: string;
  indexSha256: string;
  requestedFrom: string;
  requestedTo: string;
  sources: PeachSource[];
}
export interface PeachExtraction {
  version: number;
  requestedFrom: string;
  requestedTo: string;
  departureAirport: string;
  sources: PeachSource[];
  records: (SavedFlight & {
    sourceNumber: string;
    departureAirport: string;
    nonstop: boolean;
    sourceSha256: string;
  })[];
}
export interface EvaReceipt {
  status: string;
  sourceUrl: string;
  scope: string;
  completeRequestedScope: boolean;
  scopeEntries: number;
  verifiedDetails: number;
  query: { departure: string; arrival: string; date: string };
  requests: {
    savedFile: string;
    sha256: string;
    status: string;
    httpStatus: number;
  }[];
}
function snapshot(
  records: SavedFlight[],
  airline: 'eva' | 'peach',
  importedAt: string,
): CollectedSnapshot {
  const dates = [...new Set(records.map((r) => r.date))].sort();
  const kind = airline === 'eva' ? 'collected_eva' : 'collected_peach';
  const value: CollectedSnapshot = {
    version: 1,
    importedAt,
    records,
    coverage: [
      {
        kind,
        label: airline === 'eva' ? '長榮官方預定班表' : '樂桃官方預定班表',
        url:
          airline === 'eva'
            ? EVA_SCHEDULE_URL
            : 'https://www.flypeach.com/en/lm/st/routemap',
        fetchedAt: records.map((r) => r.fetchedAt).sort()[0],
        dates,
        records: records.length,
        description:
          '已保存並重播核對的官方預定班表候選；尚未套用，非即時動態。',
      },
    ],
  };
  validateSnapshot(value, airline);
  return value;
}
export function peachCandidate(
  raw: PeachExtraction,
  receipt: PeachReceipt,
  importedAt: string,
) {
  assert.equal(receipt.status, 'downloaded');
  assert.equal(receipt.indexUrl, 'https://www.flypeach.com/en/lm/st/routemap');
  assert.equal(raw.version, 1);
  assert.equal(raw.departureAirport, 'TPE');
  assert.equal(receipt.departureAirport, 'TPE');
  assert.equal(raw.requestedFrom, receipt.requestedFrom);
  assert.equal(raw.requestedTo, receipt.requestedTo);
  assert.ok(
    validDate(raw.requestedFrom) && raw.requestedFrom <= raw.requestedTo,
  );
  assert.equal(raw.requestedTo, '2026-12-31');
  assert.equal(raw.sources.length, 2);
  assert.equal(receipt.sources.length, 2);
  assert.equal(new Set(raw.sources.map((s) => s.id)).size, 2);
  const sources = new Map(raw.sources.map((s) => [s.url, s]));
  assert.equal(sources.size, 2);
  for (const s of raw.sources) {
    const saved = receipt.sources.find((r) => r.id === s.id);
    assert.ok(saved && s.repeatHashMatches && saved.repeatHashMatches);
    for (const field of [
      'url',
      'file',
      'sha256',
      'fetchedAt',
      'from',
      'to',
    ] as const)
      assert.equal(s[field], saved[field]);
    assert.equal(saved.repeatedSha256, saved.sha256);
    assert.equal(new URL(s.url).origin, 'https://www.flypeach.com');
    assert.ok(s.publishedAt && validDate(s.publishedAt));
  }
  const records = raw.records.map((r) => {
    assert.equal(r.departureAirport, 'TPE');
    assert.equal(r.nonstop, true);
    assert.ok(r.date >= raw.requestedFrom && r.date <= raw.requestedTo);
    const s = sources.get(r.url);
    assert.ok(s);
    assert.equal(r.sourceSha256, s.sha256);
    assert.equal(r.fetchedAt, s.fetchedAt);
    assert.equal(r.sourcePublishedAt, s.publishedAt);
    assert.ok(r.date >= s.from && r.date <= s.to);
    assert.equal(r.sourceNumber.replace(/^MM0+(?=\d)/, 'MM'), r.number);
    assert.equal(r.operatingNumber, r.number);
    return {
      number: r.sourceNumber,
      airline: r.airline,
      date: r.date,
      departure: r.departure,
      arrival: r.arrival,
      arrivalTimeZone: r.arrivalTimeZone,
      airport: r.airport,
      candidateAirport: null,
      destination: r.destination,
      destinationEnglish: r.destinationEnglish,
      countryCode: r.countryCode,
      terminal: r.terminal,
      arrivalTerminal: r.arrivalTerminal,
      aircraft: r.aircraft,
      minutes: r.minutes,
      kind: r.kind,
      label: r.label,
      url: r.url,
      fetchedAt: r.fetchedAt,
      operatingAirline: r.operatingAirline,
      operatingNumber: r.sourceNumber,
      codeshare: r.codeshare,
      page: r.page,
      sourcePublishedAt: r.sourcePublishedAt,
    };
  });
  const value = snapshot(records, 'peach', importedAt);
  const dates: string[] = [];
  for (
    let day = raw.requestedFrom;
    day <= raw.requestedTo;
    day = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10)
  )
    dates.push(day);
  assert.deepEqual(
    value.coverage[0].dates,
    dates,
    'Missing requested Peach dates',
  );
  const airports = [...new Set(records.map((r) => r.airport!))].sort();
  assert.deepEqual(
    airports,
    ['HND', 'KIX', 'NGO', 'NRT', 'OKA'],
    'Changed Peach route scope requires review',
  );
  return {
    snapshot: value,
    scope: {
      cells: dates.flatMap((date) =>
        airports.map((airport) => ({ date, airport })),
      ),
    } satisfies ObservationScope,
  };
}
export function evaCandidate(
  week: EvaWeek,
  details: EvaDetail[],
  receipt: EvaReceipt,
  importedAt: string,
) {
  assert.equal(receipt.status, 'verified_requested_scope');
  assert.equal(receipt.sourceUrl, EVA_SCHEDULE_URL);
  assert.equal(
    receipt.scope,
    'requested_date',
    'Only bounded single-date EVA refresh is supported',
  );
  assert.equal(receipt.completeRequestedScope, true);
  assert.deepEqual(week.query, receipt.query);
  assert.equal(receipt.query.departure, 'TPE');
  assert.ok(
    validDate(receipt.query.date) && receipt.query.date <= '2026-12-31',
  );
  const plan = planEvaHttpDetails(week, receipt.query.date);
  assert.ok(plan.length);
  assert.equal(plan.length, receipt.scopeEntries);
  assert.equal(details.length, plan.length);
  assert.equal(receipt.verifiedDetails, plan.length);
  assert.deepEqual(
    details.map((d) => d.detailLink).sort(),
    plan.map((d) => d.detailLink).sort(),
  );
  const analysis = analyzeEvaWeek(week, details);
  const records: SavedFlight[] = analysis.records
    .filter(
      (r) =>
        r.marketingAirline === 'BR' &&
        r.operatingAirlineCode === 'BR' &&
        !r.isCodeshare,
    )
    .map((r) => {
      assert.equal(r.departureLocal.slice(0, 10), receipt.query.date);
      assert.equal(r.arrival, receipt.query.arrival);
      const airport = arrivalAirport(r.arrival);
      assert.ok(airport);
      const d = details.find(
        (d) => d.number.replace(/^BR0+(?=\d)/, 'BR') === r.normalizedNumber,
      );
      assert.ok(d);
      const terminal = r.departureTerminal ? 'T' + r.departureTerminal : null;
      return {
        number: r.normalizedNumber,
        airline: '長榮航空',
        date: receipt.query.date,
        departure: r.departureLocal,
        arrival: r.arrivalLocal,
        arrivalTimeZone: r.arrivalTimeZone,
        airport: r.arrival,
        candidateAirport: null,
        destination: airport.city,
        destinationEnglish: airport.name,
        countryCode: airport.countryCode,
        terminal,
        arrivalTerminal: r.arrivalTerminal,
        aircraft: r.aircraft,
        minutes: r.durationMinutes,
        kind: 'collected_eva',
        label: '長榮官方預定班表',
        url: EVA_SCHEDULE_URL,
        fetchedAt: r.observedAt,
        operatingAirline: '長榮航空',
        operatingNumber: r.normalizedNumber,
        codeshare: false,
        page: null,
        detail: {
          url: new URL(d.detailLink, EVA_SCHEDULE_URL).href,
          fetchedAt: d.capturedAt,
          departureTerminal: terminal,
          arrivalTerminal: r.arrivalTerminal,
          aircraft: r.aircraft,
          scope: 'segment',
          nonstop: true,
        },
      };
    });
  return {
    snapshot: snapshot(records, 'eva', importedAt),
    scope: {
      cells: [{ date: receipt.query.date, airport: receipt.query.arrival }],
    } satisfies ObservationScope,
  };
}
