/** Offline validation of observed public DOM text. Not a network/browser crawler. */
import { validDate, validTime } from '../../../lib/time';
import {
  airportTimeZone,
  localArrival,
  utcOffset,
} from '../../../features/flights/journey-time';

const sourceAirportNames: Record<string, string> = {
  臺灣桃園國際機場: 'TPE',
  成田國際機場: 'NRT',
  仁川國際機場: 'ICN',
  '雪梨（金斯福德·史密斯）機場': 'SYD',
  舊金山國際機場: 'SFO',
  素萬那普機場: 'BKK',
};
function sourceAirport(text: string) {
  text = text.trim();
  for (const [name, code] of Object.entries(sourceAirportNames)) {
    const suffix = text.slice(name.length);
    if (
      text === name ||
      (text.startsWith(name) && /^ [A-Z0-9]+$/.test(suffix))
    ) {
      const timeZone = airportTimeZone(code);
      if (!timeZone) throw new Error('Missing verified airport time zone');
      return { code, timeZone, terminal: suffix.trim() || null };
    }
  }
  throw new Error('Unvalidated route: unknown source airport name');
}
function localInstant(date: string, time: string, zone: string) {
  const result = localArrival(date, time, zone);
  if (!result.iso)
    throw new Error(result.error ?? 'Local time could not be resolved');
  const offset = utcOffset(result.iso, zone).replace('UTC', '') || '+00:00';
  return { utc: result.iso, local: `${date}T${time}:00${offset}` };
}

export type TripCard = { summary: string; airlines: string[] };
export type TripDetail = {
  index: number;
  capturedAt: string;
  card: TripCard;
  detail: string;
  detailUrl: string;
};
export function tripCardKey(card: TripCard): string {
  return JSON.stringify([
    card.airlines.map((s) => s.trim()),
    card.summary.split('單程價格')[0].replace(/\s+/g, ' ').trim(),
  ]);
}
function minutes(text: string): number {
  const m = /^(\d+) 小時(?: (\d+) 分)?$/.exec(text);
  if (!m || Number(m[2] ?? 0) >= 60) throw new Error('Unknown duration');
  return Number(m[1]) * 60 + Number(m[2] ?? 0);
}
function date(y: string, m: string, d: string): string {
  const value = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  if (!validDate(value)) throw new Error('Invalid date');
  return value;
}
export function parseTripDirect(observation: TripDetail) {
  const text = observation.detail.replace(/\s+/g, ' ');
  if (/航段 [2-9]/.test(text))
    throw new Error('Only a single direct segment is supported');
  const m =
    /航段 1 航班於 (\d{4}) 年 (\d+) 月 (\d+) 日 (\d{2}:\d{2}) 從 (.*?) 出發，並於 (\d{4}) 年 (\d+) 月 (\d+) 日 (\d{2}:\d{2}) 抵達 (.*?) 飛行時間為 (\d+ 小時(?: \d+ 分)?) 班機詳情：([^、]+)、([A-Z0-9]{2}\d+)、([A-Z0-9]+)/.exec(
      text,
    );
  if (!m) throw new Error('Missing complete flight detail');
  const departureDate = date(m[1], m[2], m[3]);
  const arrivalDate = date(m[6], m[7], m[8]);
  const departureTime = m[4],
    arrivalTime = m[9];
  if (!validTime(departureTime) || !validTime(arrivalTime))
    throw new Error('Invalid time');
  const departureAirport = sourceAirport(m[5]);
  const destination = sourceAirport(m[10]);
  if (departureAirport.code !== 'TPE' || destination.code === 'TPE')
    throw new Error('Unvalidated route: only Taoyuan departures are supported');
  const carrier = observation.card.airlines;
  if (carrier.length !== 1) throw new Error('Ambiguous carrier');
  const label = /^(.*?)(?:\s+由(.+)營運)?$/.exec(carrier[0].trim())!;
  if (label[1].trim() !== m[12])
    throw new Error('Card/detail marketing carrier mismatch');
  const card =
    /航班於 (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):00 從 (.*?) 出發，並於 (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):00 抵達 (.*?)。\s*此為飛行時間 (\d+ 小時(?: \d+ 分)?) 的直飛航班/.exec(
      observation.card.summary,
    );
  if (
    !card ||
    JSON.stringify([
      card[1],
      card[2],
      card[3].trim(),
      card[4],
      card[5],
      card[6].trim(),
      minutes(card[7]),
    ]) !==
      JSON.stringify([
        departureDate,
        departureTime,
        m[5].trim(),
        arrivalDate,
        arrivalTime,
        m[10].trim(),
        minutes(m[11]),
      ])
  )
    throw new Error('Card/detail dates, times, terminals or duration mismatch');
  const departureInstant = localInstant(
    departureDate,
    departureTime,
    departureAirport.timeZone,
  );
  const arrivalInstant = localInstant(
    arrivalDate,
    arrivalTime,
    destination.timeZone,
  );
  const departureLocal = departureInstant.local;
  const arrivalLocal = arrivalInstant.local;
  const durationMinutes =
    (Date.parse(arrivalLocal) - Date.parse(departureLocal)) / 60_000;
  if (durationMinutes <= 0 || durationMinutes !== minutes(m[11]))
    throw new Error('UTC duration mismatch');
  if (!Number.isFinite(Date.parse(observation.capturedAt)))
    throw new Error('Invalid observation time');
  return {
    number: m[13],
    marketingAirline: m[12],
    operatingAirline: label[2]?.trim() ?? null,
    operatingFlightNumber: null,
    codeshareExplicitlyShown: Boolean(label[2]),
    departure: 'TPE',
    arrival: destination.code,
    departureLocal,
    arrivalLocal,
    departureTimeZone: 'Asia/Taipei',
    arrivalTimeZone: destination.timeZone,
    departureUtc: departureInstant.utc,
    arrivalUtc: arrivalInstant.utc,
    arrivalDayOffset:
      (Date.parse(arrivalDate) - Date.parse(departureDate)) / 86_400_000,
    departureTerminal: departureAirport.terminal,
    arrivalTerminal: destination.terminal,
    durationMinutes,
    aircraftCode: m[14],
    source: 'Trip.com public browser observation',
    sourceUrl: observation.detailUrl,
    observedAt: observation.capturedAt,
    status: 'scheduled' as const,
  };
}
export function analyzeTripDirect(
  cards: TripCard[],
  expected: number,
  details: TripDetail[],
) {
  if (!Number.isInteger(expected) || expected < 0)
    throw new Error('Invalid source count');
  const cardKeys = cards.map(tripCardKey);
  if (new Set(cardKeys).size !== cards.length)
    throw new Error('Duplicate card identity');
  const detailKeys = details.map((d) => tripCardKey(d.card));
  if (new Set(detailKeys).size !== details.length)
    throw new Error('Duplicate detail identity');
  if (detailKeys.some((key) => !cardKeys.includes(key)))
    throw new Error('Detail belongs to a different result list');
  const records = details.map(parseTripDirect);
  const missingDetails = cardKeys.filter((key) => !detailKeys.includes(key));
  return {
    scope:
      'Observed supported TPE direct results only; not all actual flights or dates',
    expectedCards: expected,
    capturedCards: cards.length,
    validatedDetails: records.length,
    completeObservedResult:
      expected > 0 && cards.length === expected && missingDetails.length === 0,
    missingDetailCount: missingDetails.length,
    codeshares: records.filter((r) => r.codeshareExplicitlyShown).length,
    marketingAirlines: [...new Set(records.map((r) => r.marketingAirline))],
    records,
  };
}

export type TripSample = {
  capturedAt: string;
  displayedDirectCount: number;
  rows: TripCard[];
  query: {
    departure: string;
    arrival: string;
    date: string;
    directOnly: boolean;
  };
};
export function analyzeTripSample(sample: TripSample, details: TripDetail[]) {
  if (
    !sample.query ||
    !sample.query.directOnly ||
    !validDate(sample.query.date)
  )
    throw new Error('Invalid direct query metadata');
  const result = analyzeTripDirect(
    sample.rows,
    sample.displayedDirectCount,
    details,
  );
  if (
    result.records.some(
      (r) =>
        r.departure !== sample.query.departure ||
        r.arrival !== sample.query.arrival ||
        !r.departureLocal.startsWith(sample.query.date + 'T'),
    )
  )
    throw new Error('Query metadata does not match observed flight records');
  return result;
}
