// Local crawler proof of concept only. Not imported by the public flight service.
import { validDate, validTime } from '@/lib/time';
import { localArrival } from '@/features/flights/journey-time';

export const CI_PDF_SOURCE =
  'https://cms-externalcontent-prod.s3.ap-northeast-1.amazonaws.com/ci/Prepare%20for%20the%20fly/CI-timetable.pdf';

export interface CiExtraction {
  coverText: string;
  pages: number;
  blocks: { page: number; text: string }[];
}
export interface CiRule {
  number: string;
  weekdays: number[];
  departureTime: string;
  arrivalTime: string;
  arrivalDayOffset: number;
  aircraft: string;
  validFrom: string;
  validUntil: string;
  sourcePage: number;
}
export interface CiTimetable {
  validFrom: string;
  validUntil: string;
  issue: string;
  rules: CiRule[];
  skippedCodeshares: number;
}
export interface CiTrialFlight {
  number: string;
  departureAirport: 'TPE';
  arrivalAirport: 'NRT';
  departureDate: string;
  departureTime: string;
  departureTimeZone: 'Asia/Taipei';
  scheduledDeparture: string;
  arrivalDate: string;
  arrivalTime: string;
  arrivalTimeZone: 'Asia/Tokyo';
  scheduledArrival: string;
  durationMinutes: number;
  aircraft: string;
  sourcePage: number;
  status: 'published_schedule';
}

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
function periodDate(value: string) {
  const match = /^(\d{2})([A-Z][a-z]{2})(\d{2})$/.exec(value);
  if (!match || !months.includes(match[2]))
    throw new Error(`Unsupported service date: ${value}`);
  const date = `20${match[3]}-${String(months.indexOf(match[2]) + 1).padStart(2, '0')}-${match[1]}`;
  if (!validDate(date)) throw new Error('Invalid service date');
  return date;
}

export function parseCiTimetable(extraction: CiExtraction): CiTimetable {
  const coverDates = extraction.coverText.match(/\d{4}\.\d{2}\.\d{2}/g);
  if (coverDates?.length !== 2)
    throw new Error('Cannot verify timetable validity');
  const [validFrom, validUntil] = coverDates.map((date) =>
    date.replaceAll('.', '-'),
  );
  if (!validDate(validFrom) || !validDate(validUntil) || validFrom > validUntil)
    throw new Error('Invalid timetable validity');
  if (Date.parse(validUntil) - Date.parse(validFrom) > 366 * 86400_000)
    throw new Error('Timetable period exceeds research limit');
  if (extraction.blocks.length !== 1)
    throw new Error('Tokyo outbound section is missing or ambiguous');
  const block = extraction.blocks[0];
  const lines = block.text.split(/\r?\n/).map((line) => line.trim());
  const start = lines.findIndex((line) =>
    line.startsWith('TAIPEI TAOYUAN TOKYO NARITA '),
  );
  if (start < 0 || !/3h20m\s*~\s*3h25m/.test(lines[start]))
    throw new Error('Layout or route duration changed; manual review required');
  const rules: CiRule[] = [];
  let skippedCodeshares = 0;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('TAIPEI ')) break;
    if (!/^CI\s+\d/.test(line)) continue;
    if (/\([A-Z0-9]{2}\s*\d+\)/.test(line)) {
      skippedCodeshares++;
      continue;
    }
    const match =
      /^CI\s+(\d{1,4})\s+([1-7\s.●·]+?)\s+(\d{2}:\d{2})-(\d{2}:\d{2})(?:\+(\d))?\s+(\S+)\s+(.+)$/.exec(
        line,
      );
    if (!match)
      throw new Error(`Cannot safely parse Tokyo schedule row: ${line}`);
    if (!validTime(match[3]) || !validTime(match[4]))
      throw new Error('Invalid flight time');
    const weekdays = [
      ...new Set((match[2].match(/[1-7]/g) || []).map(Number)),
    ].sort();
    if (!weekdays.length) throw new Error('Missing operating weekdays');
    let from = validFrom,
      until = validUntil;
    if (match[7] !== '-') {
      const period =
        /^(\d{2}[A-Z][a-z]{2}\d{2})\s*-\s*(\d{2}[A-Z][a-z]{2}\d{2})$/.exec(
          match[7],
        );
      if (!period)
        throw new Error('Unsupported exception period; manual review required');
      from = periodDate(period[1]);
      until = periodDate(period[2]);
      if (from < validFrom || until > validUntil || from > until)
        throw new Error('Service period contradicts cover validity');
    }
    rules.push({
      number: `CI${Number(match[1])}`,
      weekdays,
      departureTime: match[3],
      arrivalTime: match[4],
      arrivalDayOffset: Number(match[5] || 0),
      aircraft: match[6],
      validFrom: from,
      validUntil: until,
      sourcePage: block.page,
    });
  }
  if (rules.length < 4 || rules.length > 20)
    throw new Error('Unexpected outbound schedule count');
  return {
    validFrom,
    validUntil,
    issue: extraction.coverText.match(/Issue\s+\S+/)?.[0] || 'Unspecified',
    rules,
    skippedCodeshares,
  };
}

export function ciFlightsOnDate(
  timetable: CiTimetable,
  date: string,
): CiTrialFlight[] {
  if (!validDate(date)) throw new Error('Invalid query date');
  if (date < timetable.validFrom || date > timetable.validUntil) return [];
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
  const flights = new Map<string, CiTrialFlight>();
  for (const rule of timetable.rules) {
    if (
      date < rule.validFrom ||
      date > rule.validUntil ||
      !rule.weekdays.includes(weekday)
    )
      continue;
    const scheduledDeparture = `${date}T${rule.departureTime}:00+08:00`;
    const arrivalDate = new Date(
      Date.parse(`${date}T00:00:00Z`) + rule.arrivalDayOffset * 86400_000,
    )
      .toISOString()
      .slice(0, 10);
    const arrival = localArrival(arrivalDate, rule.arrivalTime, 'Asia/Tokyo');
    if (!arrival.iso)
      throw new Error(arrival.error || 'Arrival could not be resolved');
    const durationMinutes =
      (Date.parse(arrival.iso) - Date.parse(scheduledDeparture)) / 60_000;
    // The section explicitly states 3h20m–3h25m. This also validates local-time
    // interpretation against a separate printed fact rather than assuming UTC+8.
    if (durationMinutes < 200 || durationMinutes > 205)
      throw new Error('Time zone interpretation contradicts printed duration');
    if (flights.has(rule.number))
      throw new Error('Conflicting rows on same date; manual review required');
    flights.set(rule.number, {
      number: rule.number,
      departureAirport: 'TPE',
      arrivalAirport: 'NRT',
      departureDate: date,
      departureTime: rule.departureTime,
      departureTimeZone: 'Asia/Taipei',
      scheduledDeparture,
      arrivalDate,
      arrivalTime: rule.arrivalTime,
      arrivalTimeZone: 'Asia/Tokyo',
      scheduledArrival: arrival.iso,
      durationMinutes,
      aircraft: rule.aircraft,
      sourcePage: rule.sourcePage,
      status: 'published_schedule',
    });
  }
  return [...flights.values()].sort((a, b) =>
    a.departureTime.localeCompare(b.departureTime),
  );
}
