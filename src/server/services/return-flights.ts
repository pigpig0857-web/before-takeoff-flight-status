import snapshot from '../data/return-flights.json';
import khhExpanded from '../data/kaohsiung-expanded-returns.json';
import ciTpe from '../data/ci-tpe-returns.json';
import type {
  ReturnFlight,
  ReturnResponse,
} from '@/features/flights/return-types';
import { validDate } from '@/lib/time';

export function findReturnFlights(params: URLSearchParams): ReturnResponse {
  const date = params.get('date') || '';
  const origin = params.get('origin') || '';
  const destination = params.get('destination') || '';
  const notBefore = params.get('notBefore');
  if (
    !validDate(date) ||
    !/^[A-Z]{3}$/.test(origin) ||
    !['TPE', 'KHH'].includes(destination)
  )
    throw new Error('請選擇有效的回程日期與機場。');
  if (date < snapshot.from || date > snapshot.through)
    throw new Error(`回程班表目前可查 ${snapshot.from}～${snapshot.through}。`);
  if (
    !notBefore ||
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(notBefore) ||
    !Number.isFinite(Date.parse(notBefore))
  )
    throw new Error('缺少有效的去程抵達時間，請重新選擇去程。');
  const route = (
    [...snapshot.records, ...khhExpanded.records, ...ciTpe.records] as ReturnFlight[]
  ).filter(
    (f) => f.departureAirport === origin && f.arrivalAirport === destination,
  );
  return {
    date,
    from: snapshot.from,
    through: snapshot.through,
    routeCollected: route.length > 0,
    availableDates: [...new Set(route.map((f) => f.date))].sort(),
    partial: true,
    flights: route
      .filter(
        (f) =>
          f.date === date && Date.parse(f.departure) > Date.parse(notBefore),
      )
      .sort((a, b) => Date.parse(a.departure) - Date.parse(b.departure)),
  };
}
