import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeEvaWeek,
  evaTableEntries,
  parseEvaDetail,
  planEvaHttpDetails,
  EVA_SCHEDULE_URL,
  type EvaWeek,
  type EvaDetail,
} from '../src/server/providers/experimental/eva-schedule';
// Public observations reviewed in the official EVA timetable on 2026-10-07.
function fixture() {
  const labels = [
    'Dec. 27, 2026Sunday',
    'Dec. 28, 2026Monday',
    'Dec. 29, 2026Tuesday',
    'Dec. 30, 2026Wednesday',
    'Dec. 31, 2026Thursday',
    'Jan. 1, 2027Friday',
    'Jan. 2, 2027Saturday',
  ];
  const dates = [
    '12/27/2026',
    '12/28/2026',
    '12/29/2026',
    '12/30/2026',
    '12/31/2026',
    '01/01/2027',
    '01/02/2027',
  ];
  const week: EvaWeek = {
    capturedAt: '2026-10-07T02:10:00Z',
    sourceUrl: EVA_SCHEDULE_URL,
    rows: [
      {
        header: 'BR0184TPE07:55NRT12:00',
        cells: labels.map((dateLabel, i) => ({
          dateLabel,
          detailLink: `flight-details.aspx?Week_DT=${dates[i]}`,
          carrierImage:
            'https://booking.evaair.com/flyeva/content/images/b2c/icon_rwd/BR.png',
        })),
      },
    ],
  };
  const detail: EvaDetail = {
    capturedAt: '2026-10-07T02:12:00Z',
    number: 'BR0184',
    dateLabel: labels[3],
    detailLink: week.rows[0].cells[3].detailLink!,
    text: 'Flight details\nBR184Operated By：EVA AIR\nDec. 30, 2026\n07:55 TAIPEI\nTAIPEI (TAOYUAN) Terminal 2\n12:00 TOKYO\nTOKYO (NARITA) Terminal 1\nFlight Time\n3 Hours 5 Minutes\n787-10\nseat maps\nPlease click the link below to read more.',
  };
  return { week, detail, entry: evaTableEntries(week)[3] };
}
test('EVA official detail confirms operator, leading-zero identity and UTC duration', () => {
  const { detail, entry } = fixture();
  const flight = parseEvaDetail(detail, entry);
  assert.equal(flight.normalizedNumber, 'BR184');
  assert.equal(flight.departureLocal, '2026-12-30T07:55:00+08:00');
  assert.equal(flight.arrivalLocal, '2026-12-30T12:00:00+09:00');
  assert.equal(flight.durationMinutes, 185);
  assert.equal(flight.operatingAirline, 'EVA AIR');
  assert.equal(flight.arrivalTerminal, '1');
});
test('Near-term EVA detail may include the observed flight-status link label', () => {
  const { detail, entry } = fixture();
  const near = {
    ...detail,
    text: detail.text.replace('EVA AIR\n', 'EVA AIR View this flight status\n'),
  };
  assert.equal(
    parseEvaDetail(near, entry).departureLocal,
    '2026-12-30T07:55:00+08:00',
  );
  assert.throws(
    () =>
      parseEvaDetail(
        {
          ...near,
          text: near.text.replace(
            'View this flight status',
            'Unknown additional field',
          ),
        },
        entry,
      ),
    /mismatch/,
  );
});
test('HTTP plans use only listed services in the queried week and reject a mismatched response', () => {
  const { week } = fixture();
  assert.equal(planEvaHttpDetails(week, '2026-12-30').length, 1);
  assert.equal(planEvaHttpDetails(week, '2026-12-30', true).length, 7);
  assert.throws(() => planEvaHttpDetails(week, '2027-01-15'), /does not match/);
  const mixed = structuredClone(week);
  mixed.rows.push({
    ...mixed.rows[0],
    header: 'BR0198TPE08:50NRT12:55',
    cells: mixed.rows[0].cells.slice().reverse(),
  });
  assert.throws(
    () => planEvaHttpDetails(mixed, '2026-12-30'),
    /does not match/,
  );
  const missing = structuredClone(week);
  missing.rows[0].cells[3].detailLink = null;
  assert.throws(() => planEvaHttpDetails(missing, '2026-12-30'), /Missing/);
});
test('HTTP date ranges select only observed dates and refuse coverage beyond the response', () => {
  const { week } = fixture();
  const range = { from: '2026-12-29', through: '2026-12-31' };
  assert.equal(planEvaHttpDetails(week, '2026-12-30', false, range).length, 3);
  assert.throws(
    () =>
      planEvaHttpDetails(week, '2026-12-30', false, {
        ...range,
        through: '2027-01-03',
      }),
    /inside observed week/,
  );
  assert.throws(
    () => planEvaHttpDetails(week, '2026-12-30', true, range),
    /inside observed week/,
  );
});
test('EVA requires matching table/detail dates, times and printed duration', () => {
  const { detail, entry } = fixture();
  assert.throws(
    () =>
      parseEvaDetail(
        {
          ...detail,
          text: detail.text.replace('Dec. 30, 2026', 'Dec. 31, 2026'),
        },
        entry,
      ),
    /mismatch/,
  );
  assert.throws(
    () =>
      parseEvaDetail(
        { ...detail, text: detail.text.replace('12:00 TOKYO', '12:05 TOKYO') },
        entry,
      ),
    /mismatch/,
  );
  assert.throws(
    () =>
      parseEvaDetail(
        {
          ...detail,
          text: detail.text.replace('3 Hours 5 Minutes', '4 Hours 5 Minutes'),
        },
        entry,
      ),
    /duration/,
  );
});
test('EVA stops on wrong link dates, transfer rows, unknown airports and calendar format', () => {
  const { week } = fixture();
  for (const header of [
    'BR0184 TPE07:55HND12:00',
    'BR0184 TPE07:55NRT12:00 BR0198 NRT13:00SFO10:00',
  ]) {
    assert.throws(
      () => evaTableEntries({ ...week, rows: [{ ...week.rows[0], header }] }),
      /Unreviewed/,
    );
  }
  const bad = structuredClone(week);
  bad.rows[0].cells[3].detailLink = 'flight-details.aspx?Week_DT=12/31/2026';
  assert.throws(() => evaTableEntries(bad), /link\/cell/);
  const wrongDay = structuredClone(week);
  wrongDay.rows[0].cells[3].dateLabel = 'Dec. 30, 2026Thursday';
  assert.throws(() => evaTableEntries(wrongDay), /weekday/);
});
test('EVA partial observations remain incomplete; details cannot fill unlisted services', () => {
  const { week, detail } = fixture();
  const result = analyzeEvaWeek(week, [detail]);
  assert.equal(result.completeObservedWeek, false);
  assert.equal(result.missingDetails, 6);
  assert.throws(() => analyzeEvaWeek(week, [detail, detail]), /Duplicate/);
  const removed = structuredClone(week);
  removed.rows[0].cells[3].detailLink = null;
  assert.throws(() => analyzeEvaWeek(removed, [detail]), /not listed/);
  assert.throws(
    () => evaTableEntries({ ...week, rows: [week.rows[0], week.rows[0]] }),
    /Duplicate/,
  );
});

function routeFixture(header: string, text: string, icon = 'BR.png', day = 3) {
  const labels = [
    'Jan. 12, 2027Tuesday',
    'Jan. 13, 2027Wednesday',
    'Jan. 14, 2027Thursday',
    'Jan. 15, 2027Friday',
    'Jan. 16, 2027Saturday',
    'Jan. 17, 2027Sunday',
    'Jan. 18, 2027Monday',
  ];
  const week: EvaWeek = {
    capturedAt: '2026-10-07T03:10:00Z',
    sourceUrl: EVA_SCHEDULE_URL,
    rows: [
      {
        header,
        cells: labels.map((dateLabel, i) => ({
          dateLabel,
          detailLink: `flight-details.aspx?Week_DT=01/${12 + i}/2027`,
          carrierImage: `https://booking.evaair.com/flyeva/content/images/b2c/icon_rwd/${icon}`,
        })),
      },
    ],
  };
  const entry = evaTableEntries(week)[day];
  const detail: EvaDetail = {
    number: entry.number,
    dateLabel: labels[day],
    detailLink: entry.detailLink,
    capturedAt: week.capturedAt,
    text,
  };
  return { week, entry, detail };
}
function octoberFixture(header: string, text: string) {
  const { week } = routeFixture(header, text);
  const labels = [
    'Oct. 14, 2026Wednesday',
    'Oct. 15, 2026Thursday',
    'Oct. 16, 2026Friday',
    'Oct. 17, 2026Saturday',
    'Oct. 18, 2026Sunday',
    'Oct. 19, 2026Monday',
    'Oct. 20, 2026Tuesday',
  ];
  week.rows[0].cells.forEach((c, i) => {
    c.dateLabel = labels[i];
    c.detailLink = `flight-details.aspx?Week_DT=10/${14 + i}/2026`;
  });
  const entry = evaTableEntries(week)[0];
  return {
    entry,
    detail: {
      number: entry.number,
      dateLabel: labels[0],
      detailLink: entry.detailLink,
      capturedAt: week.capturedAt,
      text,
    },
  };
}
test('Reviewed Kansai airport label resolves Japanese arrival and rejects an unreviewed terminal', () => {
  const { entry, detail } = octoberFixture(
    'BR0178TPE06:30KIX10:10',
    'Flight details BR178Operated By：EVA AIR Oct. 14, 2026 06:30 TAIPEI TAIPEI (TAOYUAN) Terminal 2 10:10 OSAKA OSAKA(KANSAI AIRPORT) Terminal 1 Flight Time 2 Hours 40 Minutes 787-10 seat maps',
  );
  const r = parseEvaDetail(detail, entry);
  assert.equal(r.arrivalLocal, '2026-10-14T10:10:00+09:00');
  assert.equal(r.durationMinutes, 160);
  assert.throws(
    () =>
      parseEvaDetail(
        { ...detail, text: detail.text.replace('Terminal 1', 'Terminal B') },
        entry,
      ),
    /terminal/,
  );
});
test('Reviewed Los Angeles terminal B and October summer time match the printed duration', () => {
  const { entry, detail } = octoberFixture(
    'BR0006TPE10:10LAX07:15',
    'Flight details BR006Operated By：EVA AIR Oct. 14, 2026 10:10 TAIPEI TAIPEI (TAOYUAN) Terminal 2 07:15 LOS ANGELES LOS ANGELES Terminal B Flight Time 12 Hours 5 Minutes 777-300ER seat maps',
  );
  const r = parseEvaDetail(detail, entry);
  assert.equal(r.arrivalLocal, '2026-10-14T07:15:00-07:00');
  assert.equal(r.durationMinutes, 725);
  assert.equal(r.arrivalTerminal, 'B');
});
test('Reviewed ICN B7 marketing identity retains the observed EVA operator and aircraft', () => {
  const { entry, detail } = routeFixture(
    'B77028TPE07:05ICN10:30',
    'Flight details B77028Operated By：EVA Airways Jan. 15, 2027 07:05 TAIPEI TAIPEI (TAOYUAN) Terminal 2 10:30 SEOUL SEOUL (INCHEON) Terminal 1 Flight Time 2 Hours 25 Minutes A330-300 seat maps',
    'B7.png',
  );
  const r = parseEvaDetail(detail, entry);
  assert.equal(r.number, 'B77028');
  assert.equal(r.marketingAirline, 'B7');
  assert.equal(r.operatingAirline, 'EVA AIR');
  assert.equal(r.isCodeshare, true);
  assert.equal(r.operatingNumber, null);
  assert.equal(r.aircraft, 'A330-300');
  assert.equal(r.durationMinutes, 145);
});
test('Observed ICN Asiana codeshare retains OZ, terminal 2 and an absent aircraft', () => {
  const { week } = routeFixture('BR2148TPE12:25ICN15:55', '', 'co.png');
  const labels = [
    'Oct. 14, 2026Wednesday',
    'Oct. 15, 2026Thursday',
    'Oct. 16, 2026Friday',
    'Oct. 17, 2026Saturday',
    'Oct. 18, 2026Sunday',
    'Oct. 19, 2026Monday',
    'Oct. 20, 2026Tuesday',
  ];
  week.rows[0].cells.forEach((c, i) => {
    c.dateLabel = labels[i];
    c.detailLink = `flight-details.aspx?Week_DT=10/${14 + i}/2026`;
  });
  const entry = evaTableEntries(week)[3];
  const detail: EvaDetail = {
    number: entry.number,
    dateLabel: labels[3],
    detailLink: entry.detailLink,
    capturedAt: week.capturedAt,
    text: 'Flight details BR2148Operated By：Asiana Airlines Oct. 17, 2026 12:25 TAIPEI TAIPEI (TAOYUAN) Terminal 2 15:55 SEOUL SEOUL (INCHEON) Terminal 2 Flight Time 2 Hours 30 Minutes',
  };
  const record = parseEvaDetail(detail, entry);
  assert.equal(record.operatingAirlineCode, 'OZ');
  assert.equal(record.aircraft, null);
  assert.equal(record.arrivalTerminal, '2');
  assert.equal(record.durationMinutes, 150);
  assert.throws(
    () =>
      parseEvaDetail(
        {
          ...detail,
          text: detail.text.replace('Asiana Airlines', 'Thai Airways'),
        },
        entry,
      ),
    /operator/,
  );
});
test('Thai-operated BR service preserves missing aircraft and terminal without inventing operating number', () => {
  const { entry, detail } = routeFixture(
    'BR2219TPE07:55BKK10:50',
    'Flight details BR2219Operated By：Thai Airways Jan. 15, 2027 07:55 TAIPEI TAIPEI (TAOYUAN) Terminal 1 10:50 BANGKOK BANGKOK Flight Time 3 Hours 55 Minutes',
    'co.png',
  );
  const r = parseEvaDetail(detail, entry);
  assert.equal(r.operatingAirlineCode, 'TG');
  assert.equal(r.durationMinutes, 235);
  assert.equal(r.arrivalTerminal, null);
  assert.equal(r.aircraft, null);
  assert.equal(r.isCodeshare, true);
  assert.throws(
    () =>
      parseEvaDetail(
        {
          ...detail,
          text: detail.text.replace('Thai Airways', 'Unknown Airline'),
        },
        entry,
      ),
    /mismatch/,
  );
});
test('B7 detail can retain an explicit aircraft without a seat-map link', () => {
  const { entry, detail } = routeFixture(
    'B77028TPE07:30ICN11:00',
    'Flight details B77028Operated By：EVA Airways Jan. 15, 2027 07:30 TAIPEI TAIPEI (TAOYUAN) Terminal 2 11:00 SEOUL SEOUL (INCHEON) Terminal 1 Flight Time 2 Hours 30 Minutes 777-300ER Please click the link below to read more.',
    'B7.png',
  );
  assert.equal(parseEvaDetail(detail, entry).aircraft, '777-300ER');
  assert.throws(
    () =>
      parseEvaDetail(
        {
          ...detail,
          text: detail.text.replace(
            '777-300ER Please click the link below to read more.',
            'Unknown extra text',
          ),
        },
        entry,
      ),
    /aircraft/,
  );
});
test('Observed BKK +1 day must match detail; absent service cells stay absent', () => {
  const { entry, detail, week } = routeFixture(
    'BR0061TPE22:30BKK01:25+1',
    'Flight details BR061Operated By：EVA AIR Jan. 12, 2027 22:30 TAIPEI TAIPEI (TAOYUAN) Terminal 2 01:25+1 BANGKOK BANGKOK Flight Time 3 Hours 55 Minutes 787-10 seat maps',
    'BR.png',
    0,
  );
  const r = parseEvaDetail(detail, entry);
  assert.equal(r.arrivalLocal, '2027-01-13T01:25:00+07:00');
  assert.equal(r.durationMinutes, 235);
  assert.throws(
    () =>
      parseEvaDetail(
        { ...detail, text: detail.text.replace('01:25+1', '01:25') },
        entry,
      ),
    /mismatch/,
  );
  week.rows[0].cells[3].detailLink = null;
  assert.throws(() => planEvaHttpDetails(week, '2027-01-15'), /Missing/);
});
test('SFO winter arrival with earlier clock and Intl. terminal has positive UTC duration', () => {
  const { entry, detail } = routeFixture(
    'BR0008TPE11:30SFO06:40',
    'Flight details BR008Operated By：EVA AIR Jan. 15, 2027 11:30 TAIPEI TAIPEI (TAOYUAN) Terminal 2 06:40 SAN FRANCISCO SAN FRANCISCO Terminal Intl. Flight Time 11 Hours 10 Minutes 787-9 seat maps',
  );
  const r = parseEvaDetail(detail, entry);
  assert.equal(r.arrivalLocal, '2027-01-15T06:40:00-08:00');
  assert.equal(r.durationMinutes, 670);
  assert.equal(r.arrivalTerminal, 'Intl.');
  assert.throws(
    () =>
      evaTableEntries({
        ...routeFixture('BR0008TPE11:30SFO06:40', detail.text).week,
        query: { departure: 'TPE', arrival: 'BKK', date: '2027-01-15' },
      }),
    /Unreviewed/,
  );
});
test('SFO published summer observation resolves -07 without reusing winter offset', () => {
  const { week } = routeFixture('BR0008TPE10:15SFO06:45', '');
  const labels = [
    'Sep. 27, 2027Monday',
    'Sep. 28, 2027Tuesday',
    'Sep. 29, 2027Wednesday',
    'Sep. 30, 2027Thursday',
    'Oct. 1, 2027Friday',
    'Oct. 2, 2027Saturday',
    'Oct. 3, 2027Sunday',
  ];
  week.rows[0].cells = labels.map((dateLabel, i) => ({
    dateLabel,
    detailLink: `flight-details.aspx?Week_DT=${i < 4 ? '09/' + (27 + i) : '10/0' + (i - 3)}/2027`,
    carrierImage:
      'https://booking.evaair.com/flyeva/content/images/b2c/icon_rwd/BR.png',
  }));
  const entry = evaTableEntries(week)[3];
  const detail: EvaDetail = {
    number: entry.number,
    dateLabel: labels[3],
    detailLink: entry.detailLink,
    capturedAt: week.capturedAt,
    text: 'Flight details BR008Operated By：EVA AIR Sep. 30, 2027 10:15 TAIPEI TAIPEI (TAOYUAN) Terminal 2 06:45 SAN FRANCISCO SAN FRANCISCO Terminal Intl. Flight Time 11 Hours 30 Minutes 787-9 seat maps',
  };
  const r = parseEvaDetail(detail, entry);
  assert.equal(r.arrivalLocal, '2027-09-30T06:45:00-07:00');
  assert.equal(r.durationMinutes, 690);
});
