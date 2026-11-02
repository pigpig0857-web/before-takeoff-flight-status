import type { AirportGuide, Flight } from '@/features/flights/types';
import guides from '../data/peach-airport-guides.json';
import checks from '../data/peach-booking-checks.json';
import progress from '../data/peach-verification-progress.json';

interface BookingCheck {
  date: string;
  airport: string;
  number: string;
  departure: string;
  arrival: string;
  aircraft: string;
  fetchedAt: string;
  url: string;
}
const airportGuides = new Map<string, AirportGuide>(
  (guides.guides as (AirportGuide & { scope: string })[]).map((guide) => {
    if (
      guide.scope !== 'airline_airport_guide' ||
      !Number.isFinite(Date.parse(guide.fetchedAt)) ||
      guide.url !==
        `https://www.flypeach.com/en/lm/ai/airports/airportguide_international/${guide.airport.toLowerCase()}`
    )
      throw new Error('Invalid Peach airport guide');
    return [guide.airport, guide];
  }),
);
const datedChecks = checks.records as BookingCheck[];
const canonical = (number: string) => number.replace(/^MM0+(?=\d)/, 'MM');
const progressByFlight = new Map(
  (progress.records as { date: string; airport: string; number: string; state: string; checkedAt?: string; reason?: string }[]).map((record) => [
    `${record.date}|${record.airport}|${canonical(record.number)}`,
    record,
  ]),
);

/** Airport guidance is never promoted into a dated flight terminal field. */
export function enrichPeachFlight(
  flight: Flight,
  records = datedChecks,
): Flight {
  if (
    flight.origin === 'KHH' ||
    flight.airlineCode !== 'MM' ||
    !/^MM\d+$/.test(flight.number) ||
    flight.source === 'demo'
  )
    return flight;
  const departure = airportGuides.get('TPE');
  const arrival = airportGuides.get(flight.destinationCode);
  if (!departure || !arrival) return flight;
  const match = records.find(
    (check) =>
      check.date === flight.date &&
      check.airport === flight.destinationCode &&
      canonical(check.number) === canonical(flight.number) &&
      Date.parse(check.departure) === Date.parse(flight.scheduledDeparture) &&
      flight.scheduledArrival &&
      Date.parse(check.arrival) === Date.parse(flight.scheduledArrival) &&
      check.url === 'https://booking.flypeach.com/en/' &&
      Number.isFinite(Date.parse(check.fetchedAt)) &&
      ['A320', 'A320neo', 'A321LR'].includes(check.aircraft),
  );
  const currentProgress = progressByFlight.get(
    `${flight.date}|${flight.destinationCode}|${canonical(flight.number)}`,
  );
  const bookingVerification: Flight['bookingVerification'] = currentProgress
    ? {
        state: currentProgress.state as NonNullable<
          Flight['bookingVerification']
        >['state'],
        ...('checkedAt' in currentProgress
          ? { checkedAt: currentProgress.checkedAt as string }
          : {}),
        ...('reason' in currentProgress
          ? { reason: currentProgress.reason as string }
          : {}),
      }
    : { state: 'not_queried' };
  if (match) bookingVerification.state = 'verified';
  else if (bookingVerification.state === 'verified') {
    bookingVerification.state = 'mismatch';
    bookingVerification.reason = 'current_schedule_differs_from_checked_result';
  }
  return {
    ...flight,
    airportGuidance: { scope: 'airline_airport_guide', departure, arrival },
    bookingVerification,
    bookingCheck: match
      ? {
          scope: 'dated_booking_result',
          url: match.url,
          fetchedAt: match.fetchedAt,
          aircraft: match.aircraft,
        }
      : undefined,
  };
}
