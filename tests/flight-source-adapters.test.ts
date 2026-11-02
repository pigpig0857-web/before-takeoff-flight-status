import test from 'node:test';
import assert from 'node:assert/strict';
import peach from '../src/server/data/peach-flights.json';
import {
  peachCandidate,
  evaCandidate,
  type PeachReceipt,
  type PeachExtraction,
  type EvaReceipt,
} from '../scripts/flight-updates/sources';
import {
  EVA_SCHEDULE_URL,
  type EvaWeek,
  type EvaDetail,
} from '../src/server/providers/experimental/eva-schedule';
function peachFixture() {
  const receipt: PeachReceipt = {
    version: 1,
    status: 'downloaded',
    departureAirport: 'TPE',
    indexUrl: 'https://www.flypeach.com/en/lm/st/routemap',
    indexSha256: 'a'.repeat(64),
    requestedFrom: '2026-12-31',
    requestedTo: '2026-12-31',
    sources: [
      {
        id: 'summer',
        from: '2026-03-29',
        to: '2026-10-24',
        url: 'https://www.flypeach.com/application/files/20260706_S26_20260329-20261024_int_EN.pdf',
        file: 'summer.pdf',
        sha256: 'b'.repeat(64),
        repeatedSha256: 'b'.repeat(64),
        repeatHashMatches: true,
        fetchedAt: '2026-10-13T02:00:00Z',
        publishedAt: '2026-07-06',
      },
      {
        id: 'winter',
        from: '2026-10-25',
        to: '2027-03-27',
        url: peach.records.find((r) => r.date === '2026-12-31')!.url,
        file: 'winter.pdf',
        sha256: 'c'.repeat(64),
        repeatedSha256: 'c'.repeat(64),
        repeatHashMatches: true,
        fetchedAt: '2026-10-13T02:00:01Z',
        publishedAt: '2026-09-16',
      },
    ],
  };
  const raw: PeachExtraction = {
    version: 1,
    requestedFrom: receipt.requestedFrom,
    requestedTo: receipt.requestedTo,
    departureAirport: 'TPE',
    sources: structuredClone(receipt.sources),
    records: peach.records
      .filter((r) => r.date === '2026-12-31')
      .map((r) => ({
        ...r,
        kind: 'collected_peach' as const,
        number: r.number.replace(/^MM0+(?=\d)/, 'MM'),
        operatingNumber: r.number.replace(/^MM0+(?=\d)/, 'MM'),
        sourceNumber: r.number,
        departureAirport: 'TPE',
        nonstop: true,
        sourceSha256: 'c'.repeat(64),
        fetchedAt: receipt.sources[1].fetchedAt,
      })),
  };
  return { receipt, raw };
}
test('Peach source conversion covers five declared cells and keeps cross-year arrival and source publication date', () => {
  const { raw, receipt } = peachFixture(),
    v = peachCandidate(raw, receipt, '2026-10-13T03:00:00Z');
  assert.equal(v.snapshot.records.length, 11);
  assert.equal(v.scope.cells.length, 5);
  const hnd = v.snapshot.records.find((r) => r.airport === 'HND')!;
  assert.equal(hnd.arrival, '2027-01-01T00:50:00+09:00');
  assert.equal(hnd.sourcePublishedAt, '2026-09-16');
  assert.equal(hnd.aircraft, null);
  assert.equal(hnd.terminal, null);
});
test('Peach rejects source mismatch, incomplete route coverage and a download that was not independently repeated', () => {
  const { raw, receipt } = peachFixture();
  const bad = structuredClone(raw);
  bad.records[0].sourceSha256 = 'wrong';
  assert.throws(() => peachCandidate(bad, receipt, '2026-10-13T03:00:00Z'));
  const partial = structuredClone(raw);
  partial.records = partial.records.filter((r) => r.airport !== 'HND');
  assert.throws(
    () => peachCandidate(partial, receipt, '2026-10-13T03:00:00Z'),
    /route scope/,
  );
  const interrupted = structuredClone(receipt);
  interrupted.sources[0].repeatHashMatches = false;
  assert.throws(() => peachCandidate(raw, interrupted, '2026-10-13T03:00:00Z'));
});
function evaFixture() {
  const query = { departure: 'TPE', arrival: 'NRT', date: '2026-12-31' };
  const labels = [
    'Dec. 28, 2026Monday',
    'Dec. 29, 2026Tuesday',
    'Dec. 30, 2026Wednesday',
    'Dec. 31, 2026Thursday',
    'Jan. 1, 2027Friday',
    'Jan. 2, 2027Saturday',
    'Jan. 3, 2027Sunday',
  ];
  const stamps = [
    '12/28/2026',
    '12/29/2026',
    '12/30/2026',
    '12/31/2026',
    '01/01/2027',
    '01/02/2027',
    '01/03/2027',
  ];
  const week: EvaWeek = {
    sourceUrl: EVA_SCHEDULE_URL,
    capturedAt: '2026-10-13T02:00:00Z',
    query,
    rows: [
      {
        header: 'BR0184TPE07:55NRT12:00',
        cells: labels.map((dateLabel, i) => ({
          dateLabel,
          detailLink: `flight-details.aspx?Week_DT=${stamps[i]}`,
          carrierImage:
            'https://booking.evaair.com/flyeva/content/images/b2c/icon_rwd/BR.png',
        })),
      },
    ],
  };
  const detail: EvaDetail = {
    capturedAt: '2026-10-13T02:00:01Z',
    number: 'BR0184',
    dateLabel: labels[3],
    detailLink: week.rows[0].cells[3].detailLink!,
    text: 'Flight details BR184Operated By：EVA AIR Dec. 31, 2026 07:55 TAIPEI TAIPEI (TAOYUAN) Terminal 2 12:00 TOKYO TOKYO (NARITA) Terminal 1 Flight Time 3 Hours 5 Minutes 787-10 seat maps Please click the link below to read more.',
  };
  const receipt: EvaReceipt = {
    status: 'verified_requested_scope',
    sourceUrl: EVA_SCHEDULE_URL,
    scope: 'requested_date',
    completeRequestedScope: true,
    scopeEntries: 1,
    verifiedDetails: 1,
    query,
    requests: [],
  };
  return { week, detail, receipt };
}
test('EVA conversion replays exact table/detail times and records only the queried date and airport', () => {
  const { week, detail, receipt } = evaFixture(),
    v = evaCandidate(week, [detail], receipt, '2026-10-13T03:00:00Z');
  assert.deepEqual(v.scope.cells, [{ date: '2026-12-31', airport: 'NRT' }]);
  assert.equal(v.snapshot.records[0].number, 'BR184');
  assert.equal(v.snapshot.records[0].terminal, 'T2');
  assert.equal(v.snapshot.records[0].detail?.aircraft, '787-10');
});
test('EVA refuses incomplete evidence, another query date and mismatched detail times', () => {
  const { week, detail, receipt } = evaFixture();
  assert.throws(() => evaCandidate(week, [], receipt, '2026-10-13T03:00:00Z'));
  assert.throws(() =>
    evaCandidate(
      week,
      [detail],
      { ...receipt, query: { ...receipt.query, date: '2026-12-30' } },
      '2026-10-13T03:00:00Z',
    ),
  );
  assert.throws(
    () =>
      evaCandidate(
        week,
        [
          {
            ...detail,
            text: detail.text.replace('12:00 TOKYO', '12:05 TOKYO'),
          },
        ],
        receipt,
        '2026-10-13T03:00:00Z',
      ),
    /mismatch/,
  );
});
