/** Published table observations only; no recurrence extrapolation or detail inference. */
import assert from 'node:assert/strict';
const months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const weekdays = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
export function labelDate(label) {
  const m =
    /^([A-Z][a-z]{2})\. (\d{1,2}), (\d{4})(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)$/.exec(
      label ?? '',
    );
  assert.ok(m && months.includes(m[1]), 'Unknown table date');
  const date = `${m[3]}-${String(months.indexOf(m[1]) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  assert.equal(new Date(date).toISOString().slice(0, 10), date);
  assert.equal(weekdays[new Date(date).getUTCDay()], m[4]);
  return date;
}
export function parseTable(rows, airport, sourceUrl, origin = 'TPE') {
  assert.ok(['TPE', 'KHH'].includes(origin));
  assert.ok(rows.length, 'No table is not evidence of no flights');
  const dates = rows[0].cells.map((c) => labelDate(c.dateLabel));
  assert.equal(dates.length, 7);
  assert.ok(
    dates.every(
      (d, i) => !i || Date.parse(d) - Date.parse(dates[i - 1]) === 86400000,
    ),
  );
  const records = [],
    throughRecords = [],
    excluded = [];
  for (const row of rows) {
    assert.deepEqual(
      row.cells.map((c) => labelDate(c.dateLabel)),
      dates,
    );
    const m =
      new RegExp(`^((?:BR|B7)\\d+)${origin}(\\d{2}:\\d{2})([A-Z]{3})(\\d{2}:\\d{2})([+-]\\d+)?$`).exec(
        row.header,
      );
    if (!m) {
      const connection =
        /^((?:BR|B7)\d+)TPE(\d{2}:\d{2})BKK(\d{2}:\d{2})([+-]\d+)?((?:BR|B7)\d+)BKK(\d{2}:\d{2})([+-]\d+)?(AMS|LHR|VIE)(\d{2}:\d{2})([+-]\d+)?$/.exec(
          row.header,
        );
      if (
        connection &&
        connection[8] === airport &&
        [connection[2], connection[3], connection[6], connection[9]].every(
          (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t),
        ) &&
        [4, 7, 10].every(
          (i) =>
            Number(connection[i] ?? 0) >= 0 && Number(connection[i] ?? 0) <= 2,
        ) &&
        Number(connection[4] ?? 0) <= Number(connection[7] ?? 0) &&
        Number(connection[7] ?? 0) <= Number(connection[10] ?? 0)
      ) {
        excluded.push({
          header: row.header,
          reason: 'reviewed_connecting_itinerary_via_BKK',
        });
        continue;
      }
      // Preserve unknown / connecting rows, never silently call their route complete.
      excluded.push({
        header: row.header,
        reason: 'unreviewed_or_multisegment',
      });
      continue;
    }
    assert.equal(m[3], airport, 'Query/table airport mismatch');
    assert.ok([m[2], m[4]].every((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)));
    assert.ok(Math.abs(Number(m[5] ?? 0)) <= 2);
    for (const cell of row.cells) {
      if (!cell.detailLink) {
        assert.ok(!cell.carrierImage);
        continue;
      }
      const date = labelDate(cell.dateLabel),
        link = new URL(cell.detailLink, sourceUrl);
      assert.equal(link.origin, 'https://booking.evaair.com');
      assert.equal(
        link.pathname.toLowerCase(),
        '/flyeva/eva/b2c/flight-details.aspx',
      );
      assert.equal(
        link.searchParams.get('Week_DT'),
        `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`,
      );
      const image = new URL(cell.carrierImage);
      assert.equal(image.origin, link.origin);
      assert.ok(
        image.pathname.startsWith('/flyeva/content/images/b2c/icon_rwd/'),
      );
      const icon = image.pathname.split('/').at(-1);
      assert.ok(
        ['BR.png', 'B7.png', 'co.png'].includes(icon),
        'Unreviewed operator symbol',
      );
      if (icon !== 'BR.png') {
        excluded.push({
          number: m[1],
          date,
          reason:
            icon === 'co.png'
              ? 'codeshare_symbol'
              : 'B7_marketing_symbol_excluded',
          icon,
        });
        continue;
      }
      assert.ok(m[1].startsWith('BR'), 'BR symbol/marketing mismatch');
      const record = {
        number: m[1].replace(/^BR0+(?=\d)/, 'BR'),
        date,
        airport,
        departureTime: m[2],
        arrivalTime: m[4],
        arrivalDayOffset: Number(m[5] ?? 0),
        detailLink: link.href,
        operator: 'BR',
        operatorEvidence: 'official_table_BR_icon_legend',
      };
      if (
        (airport === 'AMS' && record.number === 'BR75') ||
        (airport === 'LHR' && record.number === 'BR67') ||
        (airport === 'VIE' && record.number === 'BR61')
      ) {
        throughRecords.push(record);
        excluded.push({
          number: record.number,
          date,
          reason: 'through_service_requires_BKK_first_leg_crosscheck',
        });
      } else records.push(record);
    }
  }
  const keys = records.map((r) => `${r.number}|${r.date}|${r.airport}`);
  assert.equal(new Set(keys).size, keys.length, 'Duplicate table service');
  return {
    dates,
    records,
    throughRecords,
    excluded,
    completeDirectTable: !excluded.some(
      (r) => r.reason === 'unreviewed_or_multisegment',
    ),
  };
}
