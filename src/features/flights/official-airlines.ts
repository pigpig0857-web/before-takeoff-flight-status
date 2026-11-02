import {
  arrivalAirport,
  destinationKey,
  resolveDestination,
} from './destinations';
import observedDestinations from './data/airline-destinations.json';

export interface OfficialAirline {
  code: string;
  name: string;
  url: string;
  country: string;
  category: 'low_cost' | 'full_service';
}
// These are official lookup entrances, not a dated route or availability database.
// Verified against official websites on 2026-10-05; keep maintenance here.
export const officialAirlines: OfficialAirline[] = [
  {
    code: 'PR',
    name: '菲律賓航空',
    url: 'https://www.philippineairlines.com/ph/en/flight-timetable-page.html',
    country: 'PH',
    category: 'full_service',
  },
  {
    code: 'BR',
    name: '長榮航空',
    url: 'https://www.evaair.com/zh-tw/',
    country: 'TW',
    category: 'full_service',
  },
  {
    code: 'CI',
    name: '中華航空',
    url: 'https://www.china-airlines.com/tw/zh',
    country: 'TW',
    category: 'full_service',
  },
  {
    code: 'JX',
    name: '星宇航空',
    url: 'https://www.starlux-airlines.com/zh-TW',
    country: 'TW',
    category: 'full_service',
  },
  {
    code: 'IT',
    name: '台灣虎航',
    url: 'https://www.tigerairtw.com/zh-TW/',
    country: 'TW',
    category: 'low_cost',
  },
  {
    code: 'NH',
    name: '全日空 ANA',
    url: 'https://www.ana.co.jp/zh/tw/',
    country: 'JP',
    category: 'full_service',
  },
  {
    code: 'KE',
    name: '大韓航空',
    url: 'https://www.koreanair.com/',
    country: 'KR',
    category: 'full_service',
  },
  {
    code: 'OZ',
    name: '韓亞航空',
    url: 'https://flyasiana.com/',
    country: 'KR',
    category: 'full_service',
  },
  {
    code: 'MU',
    name: '中國東方航空',
    url: 'https://www.ceair.com/',
    country: 'CN',
    category: 'full_service',
  },
  {
    code: 'CZ',
    name: '中國南方航空',
    url: 'https://www.csair.com/tw/zh/',
    country: 'CN',
    category: 'full_service',
  },
  {
    code: 'CA',
    name: '中國國際航空',
    url: 'https://www.airchina.com.tw/',
    country: 'CN',
    category: 'full_service',
  },
  {
    code: 'JL',
    name: '日本航空 JAL',
    url: 'https://www.jal.co.jp/flights/zh-tw/',
    country: 'JP',
    category: 'full_service',
  },
  {
    code: 'MM',
    name: '樂桃航空 Peach',
    url: 'https://www.flypeach.com/tw',
    country: 'JP',
    category: 'low_cost',
  },
  {
    code: '7C',
    name: '濟州航空',
    url: 'https://www.jejuair.net/zh-tw/main/base/index.do',
    country: 'KR',
    category: 'low_cost',
  },
  {
    code: 'VN',
    name: '越南航空',
    url: 'https://www.vietnamairlines.com/vn/en/',
    country: 'VN',
    category: 'full_service',
  },
  {
    code: '9C',
    name: '春秋航空',
    url: 'https://hk.ch.com/',
    country: 'CN',
    category: 'low_cost',
  },
  {
    code: 'NU',
    name: '日本越洋航空',
    url: 'https://www.jal.co.jp/tw/en/offers/okinawa-jta/',
    country: 'JP',
    category: 'full_service',
  },
  {
    code: 'GK',
    name: '捷星日本航空',
    url: 'https://www.jetstar.com/jp/ja/home',
    country: 'JP',
    category: 'low_cost',
  },
];

export function airlineEntrances(query: string): OfficialAirline[] {
  const key = destinationKey(query);
  const flightCode = /^([a-z0-9]{2})\d{1,4}$/.exec(key)?.[1].toUpperCase();
  const named = officialAirlines.find(
    (airline) =>
      airline.code === flightCode ||
      (key &&
        (destinationKey(airline.name) === key ||
          airline.code.toLowerCase() === key)),
  );
  if (named) return [named];
  const match = resolveDestination(query);
  if (!match)
    return officialAirlines.filter((airline) => airline.country === 'TW');
  const codes = new Set(match.airports.map((airport) => airport.code));
  // Observed airport links narrow lookup entrances; they are not future schedules.
  // Samples may contain codeshares, and cannot prove a direct or operating flight.
  return officialAirlines.filter((airline) => {
    const routes =
      (observedDestinations as Record<string, string[]>)[airline.code] || [];
    return routes.some((code) =>
      match.kind === 'country'
        ? arrivalAirport(code)?.countryCode === match.countryCode
        : codes.has(code),
    );
  });
}
