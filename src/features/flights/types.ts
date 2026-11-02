export type FlightStatus =
  | 'scheduled'
  | 'unconfirmed'
  | 'boarding'
  | 'departed'
  | 'delayed'
  | 'changed'
  | 'cancelled';
export type SourceKind =
  | 'realtime'
  | 'schedule'
  | 'demo'
  | 'collected_ci'
  | 'collected_trip'
  | 'collected_eva'
  | 'collected_peach'
  | 'collected_tigerair'
  | 'collected_starlux'
  | 'collected_jeju'
  | 'collected_vietnam'
  | 'collected_jta'
  | 'collected_jetstar'
  | 'collected_philippine'
  | 'collected_lion'
  | 'collected_khh_oag'
  | 'collected_khh_airport'
  | 'collected_kix';
export type CollectedSourceKind = Extract<SourceKind, `collected_${string}`>;
export interface CollectedInfo {
  label: string;
  url: string;
  fetchedAt: string;
  countryCode: string | null;
  candidateAirport: string | null;
  airportConfirmed: boolean;
  operatingAirline: string | null;
  operatingNumber: string | null;
  codeshare: boolean | null;
  sourcePage: number | null;
  sourcePublishedAt?: string;
  detail?: CollectedDetail;
  continuationAirport?: string;
  sourceNotice?: string;
  terminalReference?: {
    url: string;
    fetchedAt: string;
    basis:
      'published_airline_airport_guide' | 'published_timetable_route_header';
  };
}
export interface CollectedDetail {
  url: string;
  fetchedAt: string;
  departureTerminal: string | null;
  arrivalTerminal: string | null;
  aircraft: string | null;
  scope: 'segment';
  nonstop: true;
}
export interface Flight {
  origin?: import('./departure-airports').DepartureCode;
  timetableVerification?: import('./verification').TimetableVerification;
  id: string;
  number: string;
  airlineCode: string;
  airline: string;
  date: string;
  scheduledDeparture: string;
  reportedDeparture: string | null;
  reportedTimeKind: 'estimated' | 'actual';
  destinationCode: string;
  destination: string;
  destinationEnglish: string;
  terminal: string | null;
  gate: string | null;
  counter: string | null;
  aircraft: string | null;
  status: FlightStatus;
  sourceStatus: string;
  source: SourceKind;
  scheduledArrival?: string | null;
  arrivalTimeZone?: string | null;
  arrivalTerminal?: string | null;
  durationMinutes?: number | null;
  collected?: CollectedInfo;
  airportGuidance?: {
    scope: 'airline_airport_guide';
    departure: AirportGuide;
    arrival: AirportGuide;
  };
  bookingCheck?: {
    scope: 'dated_booking_result';
    url: string;
    fetchedAt: string;
    aircraft: string;
  };
  bookingVerification?: {
    state:
      'verified' | 'not_queried' | 'not_listed' | 'query_failed' | 'mismatch';
    checkedAt?: string;
    reason?: string;
  };
}
export interface AirportGuide {
  airport: string;
  departureLabel: string;
  arrivalLabel: string;
  url: string;
  fetchedAt: string;
}
export interface FeedInfo {
  kind: SourceKind;
  label: string;
  url: string;
  state: 'ready' | 'stale' | 'unavailable';
  fetchedAt: string | null;
  sourceUpdatedAt: string | null;
  dates: string[];
  warning: string | null;
  partial?: boolean;
  coverageDescription?: string;
}
export interface FlightDataset {
  origin?: import('./departure-airports').DepartureCode;
  mode: 'official' | 'demo';
  today: string;
  flights: Flight[];
  feeds: FeedInfo[];
  dates: string[];
  warnings: string[];
}
export interface FlightResponse extends Omit<FlightDataset, 'flights'> {
  resultState: FlightResultState;
  flights: Flight[];
  total: number;
  date: string;
  covered: boolean;
  stale: boolean;
}
export type FlightResultState =
  'matches' | 'no_matches' | 'outside_coverage' | 'unavailable' | 'partial';
export interface FlightFilters {
  origin?: import('./departure-airports').DepartureCode;
  date: string;
  q: string;
  country?: string;
  start: string;
  end: string;
  status: string;
}
export const statusLabels: Record<FlightStatus, string> = {
  scheduled: '預定班表',
  unconfirmed: '尚無動態',
  boarding: '登機中',
  departed: '已起飛',
  delayed: '延誤',
  changed: '時間異動',
  cancelled: '取消',
};
