import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeTripDirect,
  analyzeTripSample,
  parseTripDirect,
  type TripDetail,
} from '../src/server/providers/experimental/trip-direct';

// Public factual fixture; test does not make network requests or require local samples.
const sample: TripDetail = {
  index: 0,
  capturedAt: '2026-10-06T05:10:00Z',
  detailUrl: 'https://tw.trip.com/flights/',
  card: {
    airlines: ['中華航空 由日本航空營運'],
    summary:
      '航班於 2026-12-30 10:40:00 從 臺灣桃園國際機場 T2 出發，並於 2026-12-30 14:40:00 抵達 成田國際機場 T2。 此為飛行時間 3 小時 的直飛航班 單程價格：TWD27,252',
  },
  detail:
    '航段 1 航班於 2026 年 12 月 30 日 10:40 從 臺灣桃園國際機場 T2 出發，並於 2026 年 12 月 30 日 14:40 抵達 成田國際機場 T2 飛行時間為 3 小時 班機詳情：中華航空、CI9902、73H',
};
test('Direct sample preserves marketing/operator distinction and Japan local time', () => {
  const record = parseTripDirect(sample);
  assert.equal(record.number, 'CI9902');
  assert.equal(record.operatingAirline, '日本航空');
  assert.equal(record.operatingFlightNumber, null);
  assert.equal(record.arrivalUtc, '2026-12-30T05:40:00.000Z');
  assert.equal(record.durationMinutes, 180);
});

test('Observed Sydney overnight schedule resolves summer time and preserves leading zero', () => {
  const observation: TripDetail = {
    ...sample,
    card: {
      airlines: ['中華航空'],
      summary:
        '航班於 2027-01-15 23:50:00 從 臺灣桃園國際機場 T2 出發，並於 2027-01-16 12:15:00 抵達 雪梨（金斯福德·史密斯）機場 T1。 此為飛行時間 9 小時 25 分 的直飛航班',
    },
    detail:
      '航段 1 航班於 2027 年 1 月 15 日 23:50 從 臺灣桃園國際機場 T2 出發，並於 2027 年 1 月 16 日 12:15 抵達 雪梨（金斯福德·史密斯）機場 T1 飛行時間為 9 小時 25 分 班機詳情：中華航空、CI051、359',
  };
  const r = parseTripDirect(observation);
  assert.equal(r.number, 'CI051');
  assert.equal(r.arrivalLocal, '2027-01-16T12:15:00+11:00');
  assert.equal(r.arrivalTimeZone, 'Australia/Sydney');
  assert.equal(r.arrivalDayOffset, 1);
  assert.equal(r.durationMinutes, 565);
});
test('Observed San Francisco arrival on the previous calendar day has positive UTC duration and terminal I', () => {
  const observation: TripDetail = {
    ...sample,
    card: {
      airlines: ['星宇航空'],
      summary:
        '航班於 2027-01-15 00:05:00 從 臺灣桃園國際機場 T2 出發，並於 2027-01-14 19:10:00 抵達 舊金山國際機場 I。 此為飛行時間 11 小時 5 分 的直飛航班',
    },
    detail:
      '航段 1 航班於 2027 年 1 月 15 日 00:05 從 臺灣桃園國際機場 T2 出發，並於 2027 年 1 月 14 日 19:10 抵達 舊金山國際機場 I 飛行時間為 11 小時 5 分 班機詳情：星宇航空、JX012、351',
  };
  const r = parseTripDirect(observation);
  assert.equal(r.arrivalLocal, '2027-01-14T19:10:00-08:00');
  assert.equal(r.arrivalDayOffset, -1);
  assert.equal(r.arrivalTerminal, 'I');
  assert.equal(r.durationMinutes, 665);
});
test('Observed Bangkok midnight arrival keeps an absent terminal null and ignores trailing source whitespace', () => {
  const observation: TripDetail = {
    ...sample,
    card: {
      airlines: ['中華航空'],
      summary:
        '航班於 2027-01-15 22:30:00 從 臺灣桃園國際機場 T1 出發，並於 2027-01-16 01:35:00 抵達 素萬那普機場 。 此為飛行時間 4 小時 5 分 的直飛航班',
    },
    detail:
      '航段 1 航班於 2027 年 1 月 15 日 22:30 從 臺灣桃園國際機場 T1 出發，並於 2027 年 1 月 16 日 01:35 抵達 素萬那普機場 飛行時間為 4 小時 5 分 班機詳情：中華航空、CI837、32Q',
  };
  const r = parseTripDirect(observation);
  assert.equal(r.arrivalLocal, '2027-01-16T01:35:00+07:00');
  assert.equal(r.arrivalTerminal, null);
  assert.equal(r.durationMinutes, 245);
});
test('Coverage cannot claim a different query date or destination, nor prove zero flights from empty captures', () => {
  const fixture = {
    capturedAt: sample.capturedAt,
    displayedDirectCount: 1,
    rows: [sample.card],
    query: {
      departure: 'TPE',
      arrival: 'NRT',
      date: '2026-12-30',
      directOnly: true,
    },
  };
  assert.equal(
    analyzeTripSample(fixture, [sample]).completeObservedResult,
    true,
  );
  assert.throws(
    () =>
      analyzeTripSample(
        { ...fixture, query: { ...fixture.query, arrival: 'SYD' } },
        [sample],
      ),
    /metadata/,
  );
  assert.throws(
    () =>
      analyzeTripSample(
        { ...fixture, query: { ...fixture.query, date: '2027-01-15' } },
        [sample],
      ),
    /metadata/,
  );
  assert.equal(analyzeTripDirect([], 0, []).completeObservedResult, false);
});
test('Stale detail from a previous flight is rejected even if a dialog exists', () => {
  assert.throws(
    () =>
      parseTripDirect({
        ...sample,
        detail: sample.detail.replace('日 14:40', '日 15:40'),
      }),
    /mismatch/,
  );
  assert.throws(
    () =>
      parseTripDirect({
        ...sample,
        detail: sample.detail.replace('中華航空、', '日本航空、'),
      }),
    /carrier mismatch/,
  );
});
test('Missing lazy-loaded cards or detail must not produce complete coverage', () => {
  assert.equal(
    analyzeTripDirect([sample.card], 29, [sample]).completeObservedResult,
    false,
  );
  assert.equal(analyzeTripDirect([sample.card], 1, []).missingDetailCount, 1);
  assert.equal(
    analyzeTripDirect([sample.card], 1, []).completeObservedResult,
    false,
  );
});
test('Price changes do not invalidate identity; duplicate or foreign details are rejected', () => {
  const newCard = {
    ...sample.card,
    summary: sample.card.summary.replace('27,252', '28,100'),
  };
  assert.equal(
    analyzeTripDirect([newCard], 1, [sample]).completeObservedResult,
    true,
  );
  assert.throws(
    () => analyzeTripDirect([newCard], 1, [sample, sample]),
    /Duplicate/,
  );
  assert.throws(() => analyzeTripDirect([], 0, [sample]), /different result/);
});
test('Seoul route retains Korean time zone and next-day arrival without losing numeric carrier codes', () => {
  const seoul: TripDetail = {
    ...sample,
    card: {
      airlines: ['濟州航空'],
      summary:
        '航班於 2027-01-15 23:30:00 從 臺灣桃園國際機場 T1 出發，並於 2027-01-16 03:00:00 抵達 仁川國際機場 T1。 此為飛行時間 2 小時 30 分 的直飛航班 單程價格：TWD1',
    },
    // Synthetic overnight boundary; not an observed 7C6102 schedule.
    detail:
      '航段 1 航班於 2027 年 1 月 15 日 23:30 從 臺灣桃園國際機場 T1 出發，並於 2027 年 1 月 16 日 03:00 抵達 仁川國際機場 T1 飛行時間為 2 小時 30 分 班機詳情：濟州航空、7C6102、7M8',
  };
  const record = parseTripDirect(seoul);
  assert.equal(record.arrival, 'ICN');
  assert.equal(record.arrivalTimeZone, 'Asia/Seoul');
  assert.equal(record.arrivalDayOffset, 1);
  assert.equal(record.arrivalTerminal, 'T1');
  assert.equal(record.number, '7C6102');
  assert.equal(record.operatingAirline, null);
  assert.equal(record.durationMinutes, 150);
});
test('Invalid calendar dates, duration and unvalidated routes cannot be published', () => {
  assert.throws(
    () =>
      parseTripDirect({
        ...sample,
        detail: sample.detail.replace('12 月 30', '2 月 30'),
      }),
    /Invalid date/,
  );
  const wrongDuration = {
    ...sample,
    card: {
      ...sample.card,
      summary: sample.card.summary.replace('3 小時', '4 小時'),
    },
    detail: sample.detail.replace('3 小時', '4 小時'),
  };
  assert.throws(() => parseTripDirect(wrongDuration), /UTC duration/);
  assert.throws(
    () =>
      parseTripDirect({
        ...sample,
        detail: sample.detail.replace('成田國際機場', '羽田機場'),
      }),
    /Unvalidated route/,
  );
});
