export interface ReturnFlight {
  date: string;
  number: string;
  airlineCode: string;
  airline: string;
  departureAirport: string;
  arrivalAirport: 'TPE' | 'KHH';
  departure: string;
  arrival: string;
  departureTimeZone: string;
  arrivalTimeZone: string;
  arrivalDayOffset: number;
  minutes: number;
  url: string;
  fetchedAt: string;
  sourceSha256: string;
  sourceNotice?: string;
}
export interface ReturnResponse {
  flights: ReturnFlight[];
  date: string;
  from: string;
  through: string;
  routeCollected: boolean;
  availableDates: string[];
  partial: true;
}

export function returnIdentity(f: ReturnFlight) {
  return `${f.date}|${f.airlineCode}|${f.number}|${f.departureAirport}|${f.arrivalAirport}`;
}
