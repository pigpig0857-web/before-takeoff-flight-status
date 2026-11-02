// Research provider only. Printed schedules never replace live airport status.
import { validDate, validTime } from '@/lib/time';
import {
  localArrival,
  utcOffset,
  airportTimeZone,
} from '@/features/flights/journey-time';

export interface CiNetworkExtraction {
  coverText: string;
  pages: number;
  columns: { page: number; text: string }[];
}
// City mappings are candidates, not a claim that the PDF identifies an airport.
// Chengdu has multiple airports: preserve its city without choosing CTU or TFU.
const destinations: Record<string, [string | null, string]> = {
  'TOKYO NARITA': ['NRT', 'Asia/Tokyo'],
  'OSAKA KANSAI': ['KIX', 'Asia/Tokyo'],
  'SAPPORO NEW CHITOSE': ['CTS', 'Asia/Tokyo'],
  NAGOYA: ['NGO', 'Asia/Tokyo'],
  HIROSHIMA: ['HIJ', 'Asia/Tokyo'],
  TAKAMATSU: ['TAK', 'Asia/Tokyo'],
  FUKUOKA: ['FUK', 'Asia/Tokyo'],
  KUMAMOTO: ['KMJ', 'Asia/Tokyo'],
  KAGOSHIMA: ['KOJ', 'Asia/Tokyo'],
  OKINAWA: ['OKA', 'Asia/Tokyo'],
  'SEOUL INCHEON': ['ICN', 'Asia/Seoul'],
  PUSAN: ['PUS', 'Asia/Seoul'],
  BANGKOK: ['BKK', 'Asia/Bangkok'],
  'CHIANG MAI': ['CNX', 'Asia/Bangkok'],
  'KUALA LUMPUR': ['KUL', 'Asia/Kuala_Lumpur'],
  PENANG: ['PEN', 'Asia/Kuala_Lumpur'],
  SINGAPORE: ['SIN', 'Asia/Singapore'],
  JAKARTA: ['CGK', 'Asia/Jakarta'],
  'DENPASAR BALI': ['DPS', 'Asia/Makassar'],
  'HO CHI MINH CITY': ['SGN', 'Asia/Ho_Chi_Minh'],
  'DA NANG': ['DAD', 'Asia/Ho_Chi_Minh'],
  HANOI: ['HAN', 'Asia/Ho_Chi_Minh'],
  YANGON: ['RGN', 'Asia/Yangon'],
  'PHNOM PENH KTI': ['KTI', 'Asia/Phnom_Penh'],
  'KOROR PALAU': ['ROR', 'Pacific/Palau'],
  MANILA: ['MNL', 'Asia/Manila'],
  CEBU: ['CEB', 'Asia/Manila'],
  BRUNEI: ['BWN', 'Asia/Brunei'],
  'HONG KONG': ['HKG', 'Asia/Hong_Kong'],
  'BEIJING CAPITAL': ['PEK', 'Asia/Shanghai'],
  'SHANGHAI PUDONG': ['PVG', 'Asia/Shanghai'],
  GUANGZHOU: ['CAN', 'Asia/Shanghai'],
  SHENZHEN: ['SZX', 'Asia/Shanghai'],
  QINGDAO: ['TAO', 'Asia/Shanghai'],
  WUHAN: ['WUH', 'Asia/Shanghai'],
  CHENGDU: [null, 'Asia/Shanghai'],
  FUZHOU: ['FOC', 'Asia/Shanghai'],
  NANJING: ['NKG', 'Asia/Shanghai'],
  NINGBO: ['NGB', 'Asia/Shanghai'],
  XIAMEN: ['XMN', 'Asia/Shanghai'],
  ZHENGZHOU: ['CGO', 'Asia/Shanghai'],
  'LOS ANGELES': ['LAX', 'America/Los_Angeles'],
  'LA,ONTARIO': ['ONT', 'America/Los_Angeles'],
  PHOENIX: ['PHX', 'America/Phoenix'],
  'SAN FRANCISCO': ['SFO', 'America/Los_Angeles'],
  SEATTLE: ['SEA', 'America/Los_Angeles'],
  'NEW YORK JFK': ['JFK', 'America/New_York'],
  VANCOUVER: ['YVR', 'America/Vancouver'],
  SYDNEY: ['SYD', 'Australia/Sydney'],
  BRISBANE: ['BNE', 'Australia/Brisbane'],
  MELBOURNE: ['MEL', 'Australia/Melbourne'],
  FRANKFURT: ['FRA', 'Europe/Berlin'],
  AMSTERDAM: ['AMS', 'Europe/Amsterdam'],
  'LONDON HEATHROW': ['LHR', 'Europe/London'],
  VIENNA: ['VIE', 'Europe/Vienna'],
  PRAGUE: ['PRG', 'Europe/Prague'],
  ROME: ['FCO', 'Europe/Rome'],
};
const explicitAirports = new Set([
  'TOKYO NARITA',
  'OSAKA KANSAI',
  'SAPPORO NEW CHITOSE',
  'SEOUL INCHEON',
  'PHNOM PENH KTI',
  'BEIJING CAPITAL',
  'SHANGHAI PUDONG',
  'LA,ONTARIO',
  'NEW YORK JFK',
  'LONDON HEATHROW',
]);
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
function serviceDate(value: string) {
  const m = /^(\d{2})([A-Z][a-z]{2})(\d{2})$/.exec(value);
  if (!m || !months.includes(m[2]))
    throw new Error(`Invalid service date ${value}`);
  const date = `20${m[3]}-${String(months.indexOf(m[2]) + 1).padStart(2, '0')}-${m[1]}`;
  if (!validDate(date)) throw new Error(`Invalid service date ${value}`);
  return date;
}
function dateList(value: string): string[] {
  const tokens = value.trim().split(/\s+\/\s+|\s+/);
  return tokens.flatMap((token) => {
    const m = /^((?:\d{2}\/)*\d{2})([A-Z][a-z]{2}\d{2})$/.exec(token);
    if (!m) throw new Error(`Unsupported date list ${value}`);
    return m[1].split('/').map((day) => serviceDate(day + m[2]));
  });
}
export interface CiNetworkRule {
  number: string;
  marketingCarrier: string;
  operatingCarrier: string | null;
  operatingNumber: string | null;
  destinationLabel: string;
  arrivalAirport: string | null;
  candidateArrivalAirport: string | null;
  airportResolution: 'explicit_label' | 'city_candidate' | 'unresolved';
  directoryTimeZone: string | null;
  directoryTimeZoneAgrees: boolean | null;
  arrivalTimeZone: string;
  weekdays: number[];
  departureTime: string;
  arrivalTime: string;
  arrivalDayOffset: number;
  aircraft: string;
  validFrom: string;
  validUntil: string;
  onlyDates: string[] | null;
  cancelledDates: string[];
  sourcePage: number;
  sourceRow: string;
  printedDurationRange: [number, number];
  firstLegOfContinuation: boolean;
}
export interface CiNetworkTimetable {
  validFrom: string;
  validUntil: string;
  issue: string;
  rules: CiNetworkRule[];
  sections: {
    destination: string;
    page: number;
    rules: number;
    continuationRowsExcluded: number;
  }[];
}
function durationRange(text: string): [number, number] {
  const values = [...text.matchAll(/(\d+)h(?:(\d+)m)?/g)].map(
    (m) => Number(m[1]) * 60 + Number(m[2] || 0),
  );
  if (!values.length || values.length > 2)
    throw new Error('Unsupported printed duration');
  return [Math.min(...values), Math.max(...values)];
}
export function parseCiNetwork(
  extraction: CiNetworkExtraction,
): CiNetworkTimetable {
  if (extraction.columns.length !== extraction.pages)
    throw new Error('Incomplete source columns');
  const dates = extraction.coverText
    .match(/\d{4}\.\d{2}\.\d{2}/g)
    ?.map((s) => s.replaceAll('.', '-'));
  if (
    !dates ||
    dates.length !== 2 ||
    !dates.every(validDate) ||
    dates[0] > dates[1] ||
    Date.parse(dates[1]) - Date.parse(dates[0]) > 366 * 86400_000
  )
    throw new Error('Invalid cover validity');
  const [validFrom, validUntil] = dates;
  const rules: CiNetworkRule[] = [];
  const sections: CiNetworkTimetable['sections'] = [];
  const pages = new Set<number>();
  for (const column of extraction.columns) {
    if (
      !Number.isInteger(column.page) ||
      column.page < 1 ||
      column.page > extraction.pages ||
      pages.has(column.page)
    )
      throw new Error('Duplicate or invalid source page');
    pages.add(column.page);
    let current: {
      label: string;
      range: [number, number];
      section: (typeof sections)[number];
    } | null = null;
    for (const raw of column.text.split(/\r?\n/)) {
      const line = raw.trim();
      const heading = /^TAIPEI TAOYUAN (.+?)\s+(\d+h.*)$/.exec(line);
      if (heading) {
        if (!destinations[heading[1]])
          throw new Error(`Unknown destination ${heading[1]}`);
        const section = {
          destination: heading[1],
          page: column.page,
          rules: 0,
          continuationRowsExcluded: 0,
        };
        if (sections.some((s) => s.destination === section.destination))
          throw new Error('Repeated destination section');
        sections.push(section);
        current = {
          label: heading[1],
          range: durationRange(heading[2]),
          section,
        };
        continue;
      }
      // Any other route header ends the Taoyuan section, except the reviewed BNE continuation label.
      if (
        /^[A-Z][A-Z ,/]+\s+\d+h/.test(line) &&
        !(current?.label === 'BRISBANE' && line === 'AUCKLAND 3h05m')
      )
        current = null;
      if (!current) continue;
      if (
        current.label === 'BRISBANE' &&
        /^[1-7\s.●·]+\s+\d{2}:\d{2}-/.test(line)
      ) {
        current.section.continuationRowsExcluded++;
        continue;
      }
      if (!/^(CI|AE)\s+\d/.test(line)) continue;
      if (/^(CI|AE)\s+\d+(?:[/-]\d+)+/.test(line) && !/\d{2}:\d{2}/.test(line))
        continue;
      const cancel = /^(CI|AE)\s+(\d{1,4})\s+-\s+(.+)$/.exec(line);
      if (cancel) {
        const cancelled = dateList(cancel[3]);
        if (current.label === 'BRISBANE') continue; // Printed cancellation explicitly applies to BNE→AKL.
        const targets = rules.filter(
          (r) =>
            r.destinationLabel === current!.label &&
            r.number === cancel[1] + cancel[2],
        );
        if (!targets.length) throw new Error('Cancellation without schedule');
        targets.forEach((r) => r.cancelledDates.push(...cancelled));
        continue;
      }
      // English explanatory notes repeat the flight number but are not timetable rows.
      if (/^(CI|AE)\s+\d+\s+[A-Z].* flight cancelled on /.test(line)) continue;
      const m =
        /^(CI|AE)\s+(\d{1,4})\s*(?:\(([A-Z0-9]{2})\s*(\d{1,4})\)\s*)?([1-7\s.●·]+?)\s+(\d{2}:\d{2})-(\d{2}:\d{2})(?:\+(\d))?\s+(\S+)\s+(.+)$/.exec(
          line,
        );
      if (!m || !validTime(m[6]) || !validTime(m[7]))
        throw new Error(`Unsupported schedule row ${line}`);
      const weekdays = [
        ...new Set((m[5].match(/[1-7]/g) || []).map(Number)),
      ].sort();
      if (!weekdays.length) throw new Error('Missing weekdays');
      let from = validFrom,
        until = validUntil,
        onlyDates: string[] | null = null;
      if (m[10] !== '-') {
        const period =
          /^(\d{2}[A-Z][a-z]{2}\d{2})\s*-\s*(\d{2}[A-Z][a-z]{2}\d{2})$/.exec(
            m[10],
          );
        if (period) {
          from = serviceDate(period[1]);
          until = serviceDate(period[2]);
        } else {
          onlyDates = dateList(m[10]);
          from = onlyDates.reduce((a, b) => (a < b ? a : b));
          until = onlyDates.reduce((a, b) => (a > b ? a : b));
        }
      }
      if (from < validFrom || until > validUntil || from > until)
        throw new Error('Rule outside cover validity');
      const [candidate, zone] = destinations[current.label];
      // Existing directory supplies an independent time-zone cross-check where available.
      const directoryZone = candidate ? airportTimeZone(candidate) : null;
      const canonical = (z: string) =>
        new Intl.DateTimeFormat('en', { timeZone: z }).resolvedOptions()
          .timeZone;
      const directoryAgrees = directoryZone
        ? canonical(directoryZone) === canonical(zone)
        : null;
      // The saved directory labels MEL as Hobart. Preserve that discrepancy;
      // use Melbourne's named zone and independently check every printed duration.
      if (directoryAgrees === false && current.label !== 'MELBOURNE')
        throw new Error(`Destination zone disagreement ${current.label}`);
      rules.push({
        number: m[1] + m[2],
        marketingCarrier: m[1],
        operatingCarrier: m[3] || null,
        operatingNumber: m[3] ? m[3] + m[4] : null,
        destinationLabel: current.label,
        arrivalAirport: explicitAirports.has(current.label) ? candidate : null,
        candidateArrivalAirport: candidate,
        airportResolution: explicitAirports.has(current.label)
          ? 'explicit_label'
          : candidate
            ? 'city_candidate'
            : 'unresolved',
        directoryTimeZone: directoryZone,
        directoryTimeZoneAgrees: directoryAgrees,
        arrivalTimeZone: zone,
        weekdays,
        departureTime: m[6],
        arrivalTime: m[7],
        arrivalDayOffset: Number(m[8] || 0),
        aircraft: m[9],
        validFrom: from,
        validUntil: until,
        onlyDates,
        cancelledDates: [],
        sourcePage: column.page,
        sourceRow: line,
        printedDurationRange: current.range,
        firstLegOfContinuation: current.label === 'BRISBANE',
      });
      current.section.rules++;
    }
  }
  if (!rules.length || sections.some((s) => !s.rules))
    throw new Error('Missing route schedule');
  return {
    validFrom,
    validUntil,
    issue: extraction.coverText.match(/Issue\s+\S+/)?.[0] || 'Unspecified',
    rules,
    sections,
  };
}
export function ciNetworkFlightsOnDate(
  timetable: CiNetworkTimetable,
  date: string,
) {
  if (!validDate(date)) throw new Error('Invalid query date');
  if (date < timetable.validFrom || date > timetable.validUntil) return [];
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay() || 7;
  const active = timetable.rules.filter(
    (r) =>
      date >= r.validFrom &&
      date <= r.validUntil &&
      r.weekdays.includes(weekday) &&
      (!r.onlyDates || r.onlyDates.includes(date)) &&
      !r.cancelledDates.includes(date),
  );
  const seen = new Set<string>();
  return active.map((r) => {
    const key = r.destinationLabel + '|' + r.number;
    if (seen.has(key))
      throw new Error(`Conflicting active schedule ${key} ${date}`);
    seen.add(key);
    const departureLocal = `${date}T${r.departureTime}:00+08:00`;
    const arrivalDate = new Date(
      Date.parse(date + 'T00:00:00Z') + r.arrivalDayOffset * 86400_000,
    )
      .toISOString()
      .slice(0, 10);
    const arrival = localArrival(arrivalDate, r.arrivalTime, r.arrivalTimeZone);
    if (!arrival.iso) throw new Error(arrival.error || 'Unresolved arrival');
    const durationMinutes =
      (Date.parse(arrival.iso) - Date.parse(departureLocal)) / 60_000;
    if (durationMinutes <= 0 || durationMinutes > 24 * 60)
      throw new Error(`Invalid UTC duration ${key} ${date}`);
    // Route header ranges describe CI's flights; explicitly shared flights can differ.
    if (
      !r.operatingCarrier &&
      (durationMinutes < r.printedDurationRange[0] ||
        durationMinutes > r.printedDurationRange[1])
    )
      throw new Error(
        `Printed duration disagreement ${key} ${date}: ${durationMinutes}`,
      );
    return {
      ...r,
      departureAirport: 'TPE' as const,
      departureDate: date,
      departureTimeZone: 'Asia/Taipei',
      departureLocal,
      departureUtc: new Date(departureLocal).toISOString(),
      arrivalDate,
      arrivalLocal: `${arrivalDate}T${r.arrivalTime}:00${utcOffset(arrival.iso, r.arrivalTimeZone).replace('UTC', '') || '+00:00'}`,
      arrivalUtc: arrival.iso,
      durationMinutes,
      status: 'published_schedule' as const,
      departureTerminal: null,
      arrivalTerminal: null,
      gate: null,
    };
  });
}
