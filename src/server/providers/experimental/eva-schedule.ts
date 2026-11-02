/** Offline parser for reviewed EVA official direct-route tables and details. */
import { validDate, validTime } from '../../../lib/time';
import {
  airportTimeZone,
  localArrival,
  utcOffset,
} from '../../../features/flights/journey-time';
const arrivalLabels: Record<string, string> = {
  NRT: 'TOKYO TOKYO \\(NARITA\\)',
  ICN: 'SEOUL SEOUL \\(INCHEON\\)',
  BKK: 'BANGKOK BANGKOK',
  SFO: 'SAN FRANCISCO SAN FRANCISCO',
  KIX: 'OSAKA OSAKA\\(KANSAI AIRPORT\\)',
  LAX: 'LOS ANGELES LOS ANGELES',
};
export const EVA_SCHEDULE_URL =
  'https://booking.evaair.com/flyeva/eva/b2c/flight-schedules.aspx?lang=en-hk';
export type EvaRow = {
  header: string;
  cells: {
    dateLabel: string;
    detailLink: string | null;
    carrierImage: string | null;
  }[];
};
export type EvaWeek = {
  capturedAt: string;
  sourceUrl: string;
  rows: EvaRow[];
  query?: { departure: string; arrival: string; date: string };
};
export type EvaDetail = {
  capturedAt: string;
  number: string;
  dateLabel: string;
  text: string;
  detailLink: string;
};
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
function englishDate(value: string, weekdayRequired = false) {
  const m =
    /^([A-Z][a-z]{2})\. (\d{1,2}), (\d{4})(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)?$/.exec(
      value,
    );
  if (!m || !months.includes(m[1]) || (weekdayRequired && !m[4]))
    throw new Error('Unknown EVA date');
  const date = `${m[3]}-${String(months.indexOf(m[1]) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  if (
    !validDate(date) ||
    (m[4] && weekdays[new Date(date).getUTCDay()] !== m[4])
  )
    throw new Error('EVA date/weekday mismatch');
  return date;
}
const numberKey = (number: string) => number.replace(/^(BR|B7)0+(?=\d)/, '$1');
function detailDate(link: string, sourceUrl: string) {
  const url = new URL(link, sourceUrl);
  if (
    url.origin !== 'https://booking.evaair.com' ||
    url.pathname.toLowerCase() !== '/flyeva/eva/b2c/flight-details.aspx'
  )
    throw new Error('Unknown EVA detail URL');
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(
    url.searchParams.get('Week_DT') ?? '',
  );
  if (!m) throw new Error('Missing EVA detail date');
  const date = `${m[3]}-${m[1]}-${m[2]}`;
  if (!validDate(date)) throw new Error('Invalid EVA detail date');
  return date;
}
export function evaTableEntries(week: EvaWeek) {
  const source = new URL(week.sourceUrl);
  if (
    source.origin !== 'https://booking.evaair.com' ||
    source.pathname.toLowerCase() !== '/flyeva/eva/b2c/flight-schedules.aspx' ||
    !Number.isFinite(Date.parse(week.capturedAt))
  )
    throw new Error('Unknown EVA source/observation');
  const entries = week.rows.flatMap((row) => {
    const m =
      /^((?:BR|B7)\d+)\s*TPE(\d{2}:\d{2})(NRT|ICN|BKK|SFO|KIX|LAX)(\d{2}:\d{2})([+-]\d+)?$/.exec(
        row.header,
      );
    if (
      !m ||
      !validTime(m[2]) ||
      !validTime(m[4]) ||
      Math.abs(Number(m[5] ?? 0)) > 2 ||
      (m[1].startsWith('B7') && m[3] !== 'ICN') ||
      (week.query &&
        (week.query.departure !== 'TPE' || week.query.arrival !== m[3]))
    )
      throw new Error('Unreviewed EVA route or multi-segment row');
    if (row.cells.length !== 7) throw new Error('Incomplete EVA week');
    const dates = row.cells.map((cell) => englishDate(cell.dateLabel, true));
    if (
      dates.some(
        (date, i) =>
          i && Date.parse(date) - Date.parse(dates[i - 1]) !== 86400_000,
      )
    )
      throw new Error('EVA dates are not a contiguous observed week');
    return row.cells
      .filter((cell) => cell.detailLink)
      .map((cell) => {
        const date = englishDate(cell.dateLabel, true);
        if (detailDate(cell.detailLink!, week.sourceUrl) !== date)
          throw new Error('EVA link/cell date mismatch');
        const icon = cell.carrierImage?.split('/').at(-1);
        const carrier = m[1].startsWith('BR') ? 'BR' : 'B7';
        if (
          !cell.carrierImage?.startsWith(
            'https://booking.evaair.com/flyeva/content/images/b2c/icon_rwd/',
          ) ||
          !(
            icon === `${carrier}.png` ||
            (carrier === 'BR' &&
              ['BKK', 'ICN'].includes(m[3]) &&
              icon === 'co.png')
          )
        )
          throw new Error('Unknown EVA operating symbol');
        return {
          number: m[1],
          date,
          departureTime: m[2],
          arrival: m[3],
          arrivalTime: m[4],
          arrivalDayOffset: Number(m[5] ?? 0),
          marketingAirline: carrier,
          serviceIcon: icon,
          detailLink: cell.detailLink!,
        };
      });
  });
  const keys = entries.map((e) => `${numberKey(e.number)}|${e.date}`);
  if (new Set(keys).size !== keys.length)
    throw new Error('Duplicate EVA weekly identity');
  return entries;
}
/** Limit network requests to actual links in one reviewed, matching observed week. */
export function observedEvaDates(week: EvaWeek) {
  if (!week.rows.length) throw new Error('Missing EVA table');
  evaTableEntries(week);
  const dates = week.rows[0].cells.map((c) => englishDate(c.dateLabel, true));
  if (
    week.rows.some(
      (row) =>
        JSON.stringify(row.cells.map((c) => englishDate(c.dateLabel, true))) !==
        JSON.stringify(dates),
    )
  )
    throw new Error('EVA rows contain different date windows');
  return dates;
}
export function planEvaHttpDetails(
  week: EvaWeek,
  date: string,
  allWeek = false,
  range?: { from: string; through: string },
) {
  if (!validDate(date) || !week.rows.length)
    throw new Error('Invalid EVA query date/week');
  const dates = week.rows[0].cells.map((c) => englishDate(c.dateLabel, true));
  if (
    !dates.includes(date) ||
    week.rows.some(
      (row) =>
        JSON.stringify(row.cells.map((c) => englishDate(c.dateLabel, true))) !==
        JSON.stringify(dates),
    )
  )
    throw new Error('EVA response week does not match query');
  if (
    range &&
    (!validDate(range.from) ||
      !validDate(range.through) ||
      range.from > range.through ||
      date < range.from ||
      date > range.through ||
      !dates.includes(range.from) ||
      !dates.includes(range.through) ||
      allWeek)
  )
    throw new Error('EVA requested range is not inside observed week');
  const entries = evaTableEntries(week).filter((e) =>
    range
      ? e.date >= range.from && e.date <= range.through
      : allWeek || e.date === date,
  );
  if (!entries.length || entries.length > 30)
    throw new Error('Missing or excessive EVA details');
  return entries.map((entry) => ({
    ...entry,
    dateLabel: week.rows
      .flatMap((r) => r.cells)
      .find((c) => c.detailLink === entry.detailLink)!.dateLabel,
  }));
}
export function parseEvaDetail(
  detail: EvaDetail,
  entry: ReturnType<typeof evaTableEntries>[number],
  sourceUrl = EVA_SCHEDULE_URL,
) {
  if (
    numberKey(detail.number) !== numberKey(entry.number) ||
    englishDate(detail.dateLabel, true) !== entry.date ||
    detailDate(detail.detailLink, sourceUrl) !== entry.date ||
    detail.detailLink !== entry.detailLink ||
    !Number.isFinite(Date.parse(detail.capturedAt))
  )
    throw new Error('EVA detail belongs to another observation');
  const text = detail.text.replace(/\s+/g, ' ').trim();
  const m = new RegExp(
    `^Flight details ((?:BR|B7)\\d+)Operated By：(EVA AIR|EVA Airways|Thai Airways|Asiana Airlines)(?: View this flight status)? ([A-Z][a-z]{2}\\. \\d{1,2}, \\d{4}) (\\d{2}:\\d{2}) TAIPEI TAIPEI \\(TAOYUAN\\)(?: Terminal (\\d+))? (\\d{2}:\\d{2})([+-]\\d+)? ${arrivalLabels[entry.arrival]}(?: Terminal (\\d+|Intl\\.|B))? Flight Time (\\d+) Hours(?: (\\d+) Minutes)?(?: ([A-Z0-9]+(?:-[A-Z0-9]+)?)(?: seat maps\\b|(?= Please click the link below to read more\\.)))?`,
  ).exec(text);
  if (
    !m ||
    numberKey(m[1]) !== numberKey(entry.number) ||
    englishDate(m[3]) !== entry.date ||
    m[4] !== entry.departureTime ||
    m[6] !== entry.arrivalTime ||
    Number(m[7] ?? 0) !== entry.arrivalDayOffset
  )
    throw new Error('EVA table/detail schedule mismatch');
  const operator =
    m[2] === 'Thai Airways' ? 'TG' : m[2] === 'Asiana Airlines' ? 'OZ' : 'BR';
  if (m[8] === 'B' && entry.arrival !== 'LAX')
    throw new Error('Unreviewed arrival terminal');
  if (
    (entry.serviceIcon === 'co.png') !== (operator !== 'BR') ||
    (operator === 'TG' &&
      (entry.arrival !== 'BKK' || entry.marketingAirline !== 'BR')) ||
    (operator === 'OZ' &&
      (entry.arrival !== 'ICN' || entry.marketingAirline !== 'BR')) ||
    (operator === 'BR' && !m[11])
  )
    throw new Error('Unreviewed EVA operator/aircraft');
  if (operator !== 'BR' && text.slice(m[0].length).trim())
    throw new Error('Unreviewed codeshare detail suffix');
  const arrivalDate = new Date(
    Date.parse(entry.date) + entry.arrivalDayOffset * 86400_000,
  )
    .toISOString()
    .slice(0, 10);
  const zone = airportTimeZone(entry.arrival);
  if (!zone) throw new Error('Missing arrival time zone');
  const resolved = localArrival(arrivalDate, m[6], zone);
  if (!resolved.iso) throw new Error('Ambiguous destination local time');
  const departureLocal = `${entry.date}T${m[4]}:00+08:00`;
  const arrivalLocal = `${arrivalDate}T${m[6]}:00${utcOffset(resolved.iso, zone).replace('UTC', '') || '+00:00'}`;
  const durationMinutes =
    (Date.parse(arrivalLocal) - Date.parse(departureLocal)) / 60_000;
  const printedMinutes = Number(m[9]) * 60 + Number(m[10] ?? 0);
  if (
    durationMinutes <= 0 ||
    durationMinutes !== printedMinutes ||
    Number(m[10] ?? 0) >= 60 ||
    durationMinutes > 24 * 60
  )
    throw new Error('EVA UTC duration mismatch');
  return {
    number: entry.number,
    normalizedNumber: numberKey(entry.number),
    departure: 'TPE',
    arrival: entry.arrival,
    departureLocal,
    arrivalLocal,
    departureTimeZone: 'Asia/Taipei',
    arrivalTimeZone: zone,
    durationMinutes,
    departureTerminal: m[5] ?? null,
    arrivalTerminal: m[8] ?? null,
    aircraft: m[11] ?? null,
    marketingAirline: entry.marketingAirline,
    operatingAirline:
      operator === 'TG'
        ? 'Thai Airways'
        : operator === 'OZ'
          ? 'Asiana Airlines'
          : 'EVA AIR',
    sourceOperatingAirlineLabel: m[2],
    operatingAirlineCode: operator,
    operatingNumber: null,
    isCodeshare: entry.marketingAirline !== operator,
    sourceUrl,
    observedAt: detail.capturedAt,
    dataKind: 'published_schedule' as const,
  };
}
export function analyzeEvaWeek(week: EvaWeek, details: EvaDetail[]) {
  const entries = evaTableEntries(week);
  const key = (e: { number: string; dateLabel: string }) =>
    `${numberKey(e.number)}|${englishDate(e.dateLabel, true)}`;
  const detailKeys = details.map(key);
  if (new Set(detailKeys).size !== detailKeys.length)
    throw new Error('Duplicate EVA detail');
  const entryKeys = entries.map((e) => `${numberKey(e.number)}|${e.date}`);
  if (detailKeys.some((k) => !entryKeys.includes(k)))
    throw new Error('EVA detail not listed in week');
  const records = details.map((d) =>
    parseEvaDetail(d, entries[entryKeys.indexOf(key(d))], week.sourceUrl),
  );
  return {
    observedEntries: entries.length,
    verifiedDetails: records.length,
    completeObservedWeek:
      entries.length > 0 && records.length === entries.length,
    missingDetails: entries.length - records.length,
    records,
  };
}
