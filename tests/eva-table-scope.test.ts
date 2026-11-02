import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error The evidence collector is a native ESM research utility.
import * as parser from '../scripts/crawler/eva-table-scope.mjs';
const source =
  'https://booking.evaair.com/flyeva/eva/b2c/flight-schedules.aspx?lang=en-hk';
function row(header = 'BR0184TPE07:55NRT12:00', icon = 'BR.png') {
  return {
    header,
    cells: Array.from({ length: 7 }, (_, i) => ({
      dateLabel: `Oct. ${8 + i}, 2026${['Thursday', 'Friday', 'Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday'][i]}`,
      detailLink: `flight-details.aspx?Week_DT=10/${8 + i < 10 ? '0' : ''}${8 + i}/2026`,
      carrierImage: `https://booking.evaair.com/flyeva/content/images/b2c/icon_rwd/${icon}`,
    })),
  };
}
test('Daily records use source links, dates and operator icons, not recurrence guesses', () => {
  const result = parser.parseTable([row()], 'NRT', source);
  assert.equal(result.records.length, 7);
  assert.equal(result.records[0].number, 'BR184');
  assert.equal(result.completeDirectTable, true);
});
test('Codeshares are excluded even with a BR marketing number', () => {
  const result = parser.parseTable(
    [row('BR2115TPE07:00ICN10:30', 'co.png')],
    'ICN',
    source,
  );
  assert.equal(result.records.length, 0);
  assert.equal(result.excluded.length, 7);
});
test('A missing daily service remains absent', () => {
  const r = row();
  r.cells[0].detailLink = null as unknown as string;
  r.cells[0].carrierImage = null as unknown as string;
  assert.equal(parser.parseTable([r], 'NRT', source).records.length, 6);
});
test('Wrong weekdays and link dates are refused', () => {
  const r = row();
  r.cells[0].dateLabel = 'Oct. 8, 2026Friday';
  assert.throws(() => parser.parseTable([r], 'NRT', source));
  const s = row();
  s.cells[0].detailLink = 'flight-details.aspx?Week_DT=10/09/2026';
  assert.throws(() => parser.parseTable([s], 'NRT', source));
});
test('No table and unfamiliar multi-leg rows never establish complete coverage', () => {
  assert.throws(() => parser.parseTable([], 'NRT', source));
  assert.equal(
    parser.parseTable([row('BR0067TPE09:00BKK12:00LHR19:00')], 'LHR', source)
      .completeDirectTable,
    false,
  );
});
test('Another airport, invalid clock and duplicates are refused', () => {
  assert.throws(() => parser.parseTable([row()], 'KIX', source));
  assert.throws(() =>
    parser.parseTable([row('BR184TPE25:00NRT12:00')], 'NRT', source),
  );
  assert.throws(() => parser.parseTable([row(), row()], 'NRT', source));
});
test('An untrusted source detail link is refused', () => {
  const r = row();
  r.cells[0].detailLink =
    'https://example.com/flight-details.aspx?Week_DT=10/08/2026';
  assert.throws(() => parser.parseTable([r], 'NRT', source));
});
test('Reviewed connections and same-number stopovers are kept out of nonstop records', () => {
  const connection = parser.parseTable(
    [row('BR0061TPE22:40BKK01:20+1BR0075BKK11:35+1AMS18:55+1')],
    'AMS',
    source,
  );
  assert.equal(connection.completeDirectTable, true);
  assert.equal(connection.records.length, 0);
  const stopover = parser.parseTable(
    [row('BR0075TPE07:30AMS19:20')],
    'AMS',
    source,
  );
  assert.equal(stopover.records.length, 0);
  assert.equal(stopover.throughRecords.length, 7);
  assert.equal(
    parser.parseTable([row('BR0065TPE23:45VIE07:15+1')], 'VIE', source).records
      .length,
    7,
  );
});
