import assert from 'node:assert/strict';
import type { Observation } from './compare';
/** Exact dated physical legs only; operating-day rules are validation, never expansion. */
export function vietnamPublicSegments(
  raw: any,
  airport: string,
  queryDate?: string,
  origin: 'TPE' | 'KHH' = 'TPE',
): Observation[] {
  assert.equal(raw.success, true);
  assert.ok(Array.isArray(raw.data?.departureFlight?.scheduleItems));
  const rows: Observation[] = [];
  for (const item of raw.data.departureFlight.scheduleItems) {
    if (item.connectedFlights?.length !== 1) continue;
    const s = item.connectedFlights[0],
      f = s.flightInfo;
    if (
      s.numberOfStops !== 0 ||
      f.marketingAirlineCode !== 'VN' ||
      f.operatingAirlineCode !== 'VN'
    )
      continue;
    assert.equal(f.departureLocation.locationCode, origin);
    assert.equal(f.arrivalLocation.locationCode, airport);
    const date = f.departureLocation.dateTime.slice(0, 10);
    if (queryDate && date !== queryDate) continue;
    assert.ok(
      s.operatingDays.includes(
        new Date(date)
          .toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
          .toLowerCase(),
      ),
    );
    assert.ok(
      s.validityPeriod.start.slice(0, 10) <= date &&
        s.validityPeriod.end.slice(0, 10) >= date,
    );
    assert.equal(f.departureLocation.dateTimeZoneGmtOffset, 8);
    assert.equal(f.arrivalLocation.dateTimeZoneGmtOffset, 7);
    const departure = f.departureLocation.dateTime + '+08:00',
      arrival = f.arrivalLocation.dateTime + '+07:00';
    assert.equal(
      (Date.parse(arrival) - Date.parse(departure)) / 60000,
      f.duration / 60,
    );
    rows.push({
      ...(origin === 'KHH' && { origin }),
      number: 'VN' + Number(f.marketingFlightNumber),
      date,
      airport,
      departure,
      arrival,
      minutes: f.duration / 60,
    });
  }
  return rows;
}
