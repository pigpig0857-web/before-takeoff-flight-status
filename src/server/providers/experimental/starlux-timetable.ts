// Offline research parser; never registered with the live website provider.
import { validDate, validTime } from '@/lib/time';
import {
  airportTimeZone,
  localArrival,
  planArrival,
} from '@/features/flights/journey-time';
import { arrivalAirport } from '@/features/flights/destinations';

export interface StarluxTimetableRow {
  flightNo: string;
  depTime: string;
  arrTime: string;
  depAirport: string;
  arrAirport: string;
  aircraftCode: string | null;
  aircraftModel: string | null;
  operatingAirlineCode: string;
  operatingAirline: string;
  depTerminal: string | null;
  arrTerminal: string | null;
  depCity: string;
  arrCity: string;
  depAirportName: string;
  arrAirportName: string;
  duration: number;
  arrivalDaysDifference: number;
  schedule: string[];
  cargoOnly: string[];
  pendingApproval: string[];
  stops: unknown[];
}
export interface StarluxResponse {
  success: boolean;
  message: { code: string };
  data: { timetable: StarluxTimetableRow[] };
}
export interface StarluxResearchFlight {
  id: string;
  date: string;
  airlineCode: 'JX';
  flightNumber: string;
  publishedFlightNumber: string;
  origin: 'TPE';
  destination: string;
  countryCode: string;
  scheduledDeparture: string;
  scheduledArrival: string;
  arrivalLocalDate: string;
  arrivalLocalTime: string;
  arrivalTimeZone: string;
  durationMinutes: number;
  arrivalDayOffset: number;
  aircraft: string | null;
  aircraftCode: string | null;
  departureTerminal: string | null;
  arrivalTerminal: string | null;
  departureAirportName: string;
  arrivalAirportName: string;
  arrivalCity: string;
  operatingAirlineCode: string;
  operatingAirline: string;
  approvalPending: boolean;
  status: 'scheduled';
  gate: null;
  counter: null;
  sourceRow: number;
}
export function starluxDay(date: string, n: number): string {
  if (!validDate(date) || !Number.isInteger(n)) throw new Error('Invalid date');
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400_000)
    .toISOString()
    .slice(0, 10);
}
export function parseStarluxWeek(
  response: StarluxResponse,
  query: {
    destination: string;
    date: string;
    from: string;
    through: string;
  },
  verifiedZones: Record<string, string> = {},
) {
  if (
    !validDate(query.date) ||
    !validDate(query.from) ||
    !validDate(query.through) ||
    query.through < query.from
  )
    throw new Error('Invalid query scope');
  if (
    response.success !== true ||
    response.message?.code !== '00000' ||
    !Array.isArray(response.data?.timetable)
  )
    throw new Error('Failed/unrecognized official response');
  const start = starluxDay(query.date, -3),
    end = starluxDay(query.date, 3);
  const flights: StarluxResearchFlight[] = [];
  const pending: {
    rowIndex: number;
    reason: string;
    row: StarluxTimetableRow;
  }[] = [];
  const excluded: { rowIndex: number; reason: string; dates: string[] }[] = [];
  response.data.timetable.forEach((row, rowIndex) => {
    try {
      if (
        row.depAirport !== 'TPE' ||
        row.arrAirport !== query.destination ||
        !/^JX\d{4}$/.test(row.flightNo)
      )
        throw new Error('Query/identity mismatch');
      for (const key of ['schedule', 'cargoOnly', 'pendingApproval'] as const) {
        if (
          !Array.isArray(row[key]) ||
          row[key].some((d) => !validDate(d) || d < start || d > end) ||
          new Set(row[key]).size !== row[key].length
        )
          throw new Error(`Invalid or duplicate ${key} dates`);
      }
      if (
        row.cargoOnly.some((d) => !row.schedule.includes(d)) ||
        row.pendingApproval.some((d) => !row.schedule.includes(d))
      )
        throw new Error('Exception not in schedule');
      if (!Array.isArray(row.stops)) throw new Error('Missing stop evidence');
      if (row.stops.length || row.operatingAirlineCode !== 'JX') {
        excluded.push({
          rowIndex,
          reason: row.stops.length
            ? 'has_stop_or_connection'
            : 'other_operating_airline',
          dates: row.schedule,
        });
        return;
      }
      if (
        !validTime(row.depTime) ||
        !validTime(row.arrTime) ||
        !Number.isInteger(row.duration) ||
        row.duration <= 0 ||
        !Number.isInteger(row.arrivalDaysDifference) ||
        row.arrivalDaysDifference < -1 ||
        row.arrivalDaysDifference > 2
      )
        throw new Error('Invalid times/duration/day offset');
      const airport = arrivalAirport(row.arrAirport);
      const zone =
        airportTimeZone(row.arrAirport) || verifiedZones[row.arrAirport];
      if (!airport || !zone)
        throw new Error('Unconfirmed destination/timezone');
      const nullableText = (text: unknown) => {
        if (text === null) return null;
        if (typeof text !== 'string')
          throw new Error('Malformed optional field');
        return text.trim() || null;
      };
      const aircraft = nullableText(row.aircraftModel),
        aircraftCode = nullableText(row.aircraftCode);
      const departureTerminal = nullableText(row.depTerminal),
        arrivalTerminal = nullableText(row.arrTerminal);
      const rows: StarluxResearchFlight[] = [];
      for (const date of row.schedule) {
        if (date < query.from || date > query.through) continue;
        if (row.cargoOnly.includes(date)) {
          excluded.push({ rowIndex, reason: 'cargo_only', dates: [date] });
          continue;
        }
        const dep = localArrival(date, row.depTime, 'Asia/Taipei');
        const arrivalLocalDate = starluxDay(date, row.arrivalDaysDifference);
        const arr = planArrival(dep.iso!, arrivalLocalDate, row.arrTime, zone);
        if (!dep.iso || !arr.iso || arr.minutes !== row.duration)
          throw new Error(
            `Time/duration disagreement ${date}: ${arr.error || arr.minutes}`,
          );
        const flightNumber = `JX${Number(row.flightNo.slice(2))}`;
        rows.push({
          id: `${date}|TPE|${row.arrAirport}|${flightNumber}`,
          date,
          airlineCode: 'JX',
          flightNumber,
          publishedFlightNumber: row.flightNo,
          origin: 'TPE',
          destination: row.arrAirport,
          countryCode: airport.countryCode,
          scheduledDeparture: dep.iso,
          scheduledArrival: arr.iso,
          arrivalLocalDate,
          arrivalLocalTime: row.arrTime,
          arrivalTimeZone: zone,
          durationMinutes: row.duration,
          arrivalDayOffset: row.arrivalDaysDifference,
          aircraft,
          aircraftCode,
          departureTerminal,
          arrivalTerminal,
          departureAirportName: row.depAirportName,
          arrivalAirportName: row.arrAirportName,
          arrivalCity: row.arrCity,
          operatingAirlineCode: row.operatingAirlineCode,
          operatingAirline: row.operatingAirline,
          approvalPending: row.pendingApproval.includes(date),
          status: 'scheduled',
          gate: null,
          counter: null,
          sourceRow: rowIndex,
        });
      }
      flights.push(...rows);
    } catch (error) {
      pending.push({
        rowIndex,
        reason: error instanceof Error ? error.message : String(error),
        row,
      });
    }
  });
  // Never allow multiple rows to silently choose aircraft/times for one flight.
  const grouped = new Map<string, StarluxResearchFlight[]>();
  for (const f of flights) grouped.set(f.id, [...(grouped.get(f.id) || []), f]);
  const conflicts = [...grouped]
    .filter(([, rows]) => rows.length > 1)
    .map(([id, rows]) => ({ id, rows }));
  return {
    flights: [...grouped.values()]
      .filter((rows) => rows.length === 1)
      .map((rows) => rows[0]),
    pending,
    excluded,
    conflicts,
    start,
    end,
  };
}
