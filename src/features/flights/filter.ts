import type { Flight, FlightFilters } from './types';
import { findActiveAirline } from './airline-scope';
import { clock, validDate, validTime } from '@/lib/time';
import { departureAirport, type DepartureCode } from './departure-airports';
import {
  arrivalAirport,
  destinationCountry,
  matchesDestination,
  resolveDestination,
} from './destinations';
export function normalizeQuery(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s-]/g, '')
    .replace(/^([a-z0-9]{2})0+(?=\d)/, '$1');
}
export function parseFilters(
  params: URLSearchParams,
  today: string,
): FlightFilters {
  const date = params.get('date') || today;
  const q = (params.get('q') || '').trim();
  const country = (params.get('country') || '').trim().toUpperCase();
  const start = params.get('start') || '00:00';
  const end = params.get('end') || '23:59';
  const status = params.get('status') || '';
  const origin = params.get('origin');
  if (origin !== null && origin !== 'TPE' && origin !== 'KHH')
    throw new Error('請選擇有效的出發機場。');
  if (!validDate(date)) throw new Error('請選擇有效的出發日期。');
  if (!validTime(start) || !validTime(end) || start > end)
    throw new Error('結束時間不能早於開始時間；跨日請分別查詢兩個日期。');
  if (q.length > 100) throw new Error('搜尋文字請限制在 100 字以內。');
  if (country && !destinationCountry(country))
    throw new Error('請選擇有效的目的地國家／地區。');
  if (
    ![
      '',
      'scheduled',
      'unconfirmed',
      'boarding',
      'departed',
      'delayed',
      'changed',
      'cancelled',
    ].includes(status)
  )
    throw new Error('航班狀態無效。');
  return {
    date,
    q,
    start,
    end,
    status,
    ...(country ? { country } : {}),
    ...(origin ? { origin: origin as DepartureCode } : {}),
  };
}
export function filterFlights(
  flights: Flight[],
  filters: FlightFilters,
): Flight[] {
  const query = normalizeQuery(filters.q);
  const isFlightNumber = /^[a-z0-9]{2}\d+[a-z]?$/.test(query);
  const airline = findActiveAirline(filters.q);
  const destination = airline ? null : resolveDestination(filters.q);
  return flights
    .filter((f) => {
      // A query is for one departure date. Avoid time-zone formatting for all
      // the other dates in the saved catalogue.
      if (f.date !== filters.date) return false;
      if ((f.origin || 'TPE') !== (filters.origin || 'TPE')) return false;
      const time = clock(f.scheduledDeparture);
      return (
        time >= filters.start &&
        time <= filters.end &&
        (!filters.status || f.status === filters.status) &&
        (!filters.country ||
          (arrivalAirport(f.destinationCode)?.countryCode ||
            f.collected?.countryCode) === filters.country) &&
        (!query ||
          (isFlightNumber
            ? normalizeQuery(f.number) === query
            : airline
              ? f.airlineCode === airline.code
              : destination
                ? matchesDestination(f, destination)
                : [
                    f.number,
                    f.airline,
                    f.airlineCode,
                    f.destination,
                    f.destinationCode,
                    f.destinationEnglish,
                    `${departureAirport(f).city} ${departureAirport(f).code}`,
                  ].some((value) => normalizeQuery(value).includes(query))))
      );
    })
    .sort(
      (a, b) =>
        a.scheduledDeparture.localeCompare(b.scheduledDeparture) ||
        a.number.localeCompare(b.number),
    );
}
