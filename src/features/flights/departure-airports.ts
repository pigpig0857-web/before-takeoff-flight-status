import type { Flight } from './types';
export type DepartureCode = 'TPE' | 'KHH';
export const kaohsiungAirlineCodes: readonly string[] = [
  'IT',
  'MM',
  'GK',
  '7C',
  'BR',
  'VN',
  'SL',
  'CI',
  'CX',
  'UO',
  'TW',
  'UA',
  'TG',
  'AK',
  'FD',
  '5J',
  'Z2',
];
export const departureAirports = {
  TPE: {
    code: 'TPE',
    city: '桃園',
    name: '桃園國際機場',
    english: 'TAOYUAN',
    coordinates: '25°04′ N · 121°13′ E',
    url: 'https://web.taoyuan-airport.com/index.aspx',
    guide: 'https://www.taoyuan-airport.com/go_abroad/index.html',
  },
  KHH: {
    code: 'KHH',
    city: '高雄',
    name: '高雄國際機場',
    english: 'KAOHSIUNG',
    coordinates: '22°35′ N · 120°21′ E',
    url: 'https://www.kia.gov.tw/',
    guide: 'https://www.kia.gov.tw/FACNSER-onboard.html',
  },
} as const;
export function departureAirport(flight: Pick<Flight, 'origin'>) {
  return departureAirports[flight.origin || 'TPE'];
}
