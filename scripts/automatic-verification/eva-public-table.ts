import assert from 'node:assert/strict';
// @ts-expect-error The established table parser is a native ESM module.
import { parseTable } from '../crawler/eva-table-scope.mjs';
import {
  airportTimeZone,
  localArrival,
  utcOffset,
} from '../../src/features/flights/journey-time';
import type { Observation } from './compare';
export const evaScheduleURL =
  'https://booking.evaair.com/flyeva/eva/b2c/flight-schedules.aspx?lang=en-hk';
export function evaTableObservations(
  rows: any[],
  airport: string,
  from: string,
  through: string,
  origin: 'TPE' | 'KHH' = 'TPE',
) {
  const result = parseTable(rows, airport, evaScheduleURL, origin);
  assert.equal(
    result.completeDirectTable,
    true,
    'Unknown or connecting table rows require review',
  );
  const zone = airportTimeZone(airport);
  assert.ok(zone, 'Unknown airport timezone');
  const observations: Observation[] = result.records
    .filter((r: any) => r.date >= from && r.date <= through)
    .map((r: any) => {
      const arrivalDate = new Date(
        Date.parse(r.date) + r.arrivalDayOffset * 86400_000,
      )
        .toISOString()
        .slice(0, 10);
      const resolved = localArrival(arrivalDate, r.arrivalTime, zone);
      assert.ok(resolved.iso, 'Ambiguous arrival must remain pending');
      const departure = `${r.date}T${r.departureTime}:00+08:00`,
        arrival = `${arrivalDate}T${r.arrivalTime}:00${utcOffset(resolved.iso, zone).replace('UTC', '') || '+00:00'}`;
      return {
        ...(origin === 'KHH' && { origin }),
        number: r.number,
        date: r.date,
        airport,
        departure,
        arrival,
        minutes: (Date.parse(arrival) - Date.parse(departure)) / 60000,
      };
    });
  return {
    observations,
    dates: result.dates,
    throughRecords: result.throughRecords,
  };
}
