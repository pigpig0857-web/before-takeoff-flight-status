// Research only: this provider is intentionally not registered in the website.
import { validDate, validTime } from '@/lib/time';
import {
  airportTimeZone,
  localArrival,
  planArrival,
} from '@/features/flights/journey-time';
import { arrivalAirport } from '@/features/flights/destinations';

export const tigerWeekdays = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;
export interface TigerRule {
  origin: string;
  destination: string;
  carrierCode: string;
  flightNumber: string;
  departureTime: string;
  arrivalTime: string;
  daysOfWeek: Record<(typeof tigerWeekdays)[number], boolean>;
  operationDateSummary: string;
  overnight: number;
  durationInMinutes: number;
}
export interface TigerSnapshot {
  data: {
    countryCode: string;
    stationSchedules: { iataCode: string; schedules: TigerRule[] }[];
  }[];
}
export interface TigerFlight {
  id: string;
  date: string;
  origin: 'TPE' | 'KHH';
  destination: string;
  countryCode: string;
  flightNumber: string;
  airlineCode: 'IT';
  scheduledDeparture: string;
  scheduledArrival: string;
  arrivalLocalDate: string;
  arrivalLocalTime: string;
  arrivalTimeZone: string;
  durationMinutes: number;
  arrivalDayOffset: number;
  sourceRuleIndexes: number[];
  aircraft: null;
  departureTerminal: null;
  arrivalTerminal: null;
  gate: null;
  counter: null;
  status: 'scheduled';
}

export function addTigerDays(date: string, days: number): string {
  if (!validDate(date) || !Number.isInteger(days))
    throw new Error('Invalid date/day offset');
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400_000)
    .toISOString()
    .slice(0, 10);
}

// Commas and Japanese/Chinese enumeration separators both appear in the official
// feed. A shortened MM/DD inherits the last explicit year, including a range end.
export function tigerDatePeriods(
  summary: string,
): { from: string; through: string }[] {
  if (typeof summary !== 'string' || !summary.trim())
    throw new Error('Missing operating dates');
  let year: string | undefined;
  let previousDate: string | undefined;
  const parse = (token: string) => {
    const match = /^(?:(\d{4})\/)?(\d{2})\/(\d{2})$/.exec(token.trim());
    if (!match || (!match[1] && !year))
      throw new Error(`Unrecognized date: ${token}`);
    year = match[1] || year;
    const date = `${year}-${match[2]}-${match[3]}`;
    if (!validDate(date)) throw new Error(`Invalid operating date: ${date}`);
    if (!match[1] && previousDate && date < previousDate)
      throw new Error(`Ambiguous shortened date: ${token}`);
    previousDate = date;
    return date;
  };
  return summary.split(/[,、]/).map((segment) => {
    const ends = segment.trim().split('-');
    if (ends.length > 2) throw new Error(`Unrecognized range: ${segment}`);
    const from = parse(ends[0]);
    const through = ends.length === 2 ? parse(ends[1]) : from;
    if (through < from)
      throw new Error(`Reversed or ambiguous range: ${segment}`);
    return { from, through };
  });
}

function tigerClock(time: string): string {
  if (
    typeof time !== 'string' ||
    !/^\d{2}:\d{2}:00$/.test(time) ||
    !validTime(time.slice(0, 5))
  )
    throw new Error(`Unsupported time: ${time}`);
  return time.slice(0, 5);
}

export function expandTigerSnapshot(
  snapshot: TigerSnapshot,
  from: string,
  through: string,
  verifiedTimeZones: Record<string, string> = {},
  origin: 'TPE' | 'KHH' = 'TPE',
) {
  if (
    !validDate(from) ||
    !validDate(through) ||
    through < from ||
    Date.parse(through) - Date.parse(from) > 366 * 86400_000
  )
    throw new Error('Invalid research window');
  if (!Array.isArray(snapshot.data) || snapshot.data.length === 0)
    throw new Error('Empty/unrecognized snapshot');
  const records = new Map<string, TigerFlight>();
  const pending: { ruleIndex: number; rule: TigerRule; reason: string }[] = [];
  const conflicts = new Map<string, TigerFlight[]>();
  const rules: {
    ruleIndex: number;
    countryCode: string;
    rule: TigerRule;
    expanded: number;
  }[] = [];
  let rawRules = 0;
  let identicalOverlap = 0;
  for (const country of snapshot.data) {
    if (!Array.isArray(country.stationSchedules))
      throw new Error('Missing station schedules');
    for (const station of country.stationSchedules) {
      if (!Array.isArray(station.schedules)) throw new Error('Missing rules');
      for (const rule of station.schedules) {
        const ruleIndex = rawRules++;
        if (rule.origin !== origin) continue;
        try {
          if (
            rule.carrierCode !== 'IT' ||
            !/^\d{1,4}$/.test(rule.flightNumber) ||
            !/^[A-Z]{3}$/.test(rule.destination) ||
            rule.destination === origin
          )
            throw new Error('Unexpected identity');
          if (station.iataCode !== rule.destination)
            throw new Error('Station/destination disagreement');
          const airport = arrivalAirport(rule.destination);
          if (!airport || airport.countryCode !== country.countryCode)
            throw new Error('Unconfirmed destination/country');
          const zone =
            airportTimeZone(rule.destination) ||
            verifiedTimeZones[rule.destination];
          if (!zone) throw new Error('Unconfirmed destination timezone');
          if (
            !rule.daysOfWeek ||
            tigerWeekdays.some(
              (d) => typeof rule.daysOfWeek[d] !== 'boolean',
            ) ||
            !tigerWeekdays.some((d) => rule.daysOfWeek[d])
          )
            throw new Error('Missing/empty weekdays');
          if (
            !Number.isInteger(rule.overnight) ||
            rule.overnight < 0 ||
            rule.overnight > 2 ||
            !Number.isInteger(rule.durationInMinutes) ||
            rule.durationInMinutes <= 0
          )
            throw new Error('Invalid duration/day offset');
          const dep = tigerClock(rule.departureTime);
          const arr = tigerClock(rule.arrivalTime);
          const periods = tigerDatePeriods(rule.operationDateSummary);
          // Validate the entire rule before inserting any of its dates.
          const expanded: TigerFlight[] = [];
          for (let date = from; date <= through; date = addTigerDays(date, 1)) {
            if (
              !periods.some((p) => p.from <= date && date <= p.through) ||
              !rule.daysOfWeek[
                tigerWeekdays[new Date(`${date}T00:00:00Z`).getUTCDay()]
              ]
            )
              continue;
            const departure = localArrival(date, dep, 'Asia/Taipei');
            const arrivalDate = addTigerDays(date, rule.overnight);
            const arrival = planArrival(departure.iso!, arrivalDate, arr, zone);
            if (
              !departure.iso ||
              !arrival.iso ||
              arrival.minutes !== rule.durationInMinutes
            )
              throw new Error(
                `Unconfirmed time/duration at ${date}: ${arrival.error || arrival.minutes}`,
              );
            const flightNumber = `IT${rule.flightNumber}`;
            expanded.push({
              id: `${date}|${origin}|${rule.destination}|${flightNumber}`,
              date,
              origin,
              destination: rule.destination,
              countryCode: country.countryCode,
              flightNumber,
              airlineCode: 'IT',
              scheduledDeparture: departure.iso,
              scheduledArrival: arrival.iso,
              arrivalLocalDate: arrivalDate,
              arrivalLocalTime: arr,
              arrivalTimeZone: zone,
              durationMinutes: rule.durationInMinutes,
              arrivalDayOffset: rule.overnight,
              sourceRuleIndexes: [ruleIndex],
              aircraft: null,
              departureTerminal: null,
              arrivalTerminal: null,
              gate: null,
              counter: null,
              status: 'scheduled',
            });
          }
          rules.push({
            ruleIndex,
            countryCode: country.countryCode,
            rule,
            expanded: expanded.length,
          });
          for (const flight of expanded) {
            if (conflicts.has(flight.id)) {
              conflicts.get(flight.id)!.push(flight);
              continue;
            }
            const previous = records.get(flight.id);
            if (!previous) {
              records.set(flight.id, flight);
              continue;
            }
            if (
              previous.scheduledDeparture !== flight.scheduledDeparture ||
              previous.scheduledArrival !== flight.scheduledArrival ||
              previous.durationMinutes !== flight.durationMinutes
            ) {
              conflicts.set(flight.id, [previous, flight]);
              records.delete(flight.id);
            } else {
              previous.sourceRuleIndexes.push(ruleIndex);
              identicalOverlap++;
            }
          }
        } catch (error) {
          pending.push({
            ruleIndex,
            rule,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
  const flights = [...records.values()].sort(
    (a, b) =>
      a.scheduledDeparture.localeCompare(b.scheduledDeparture) ||
      a.id.localeCompare(b.id),
  );
  return {
    flights,
    pending,
    conflicts: [...conflicts].map(([id, observations]) => ({
      id,
      observations,
    })),
    rawRules,
    tpeRules: rules.length + pending.length,
    rules,
    identicalOverlap,
  };
}
