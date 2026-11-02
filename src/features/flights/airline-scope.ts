import type { Flight } from './types';

// Current public catalogue scope. Keep archived providers/data for later expansion.
export const activeAirlines = [
  { code: 'BR', name: '長榮航空' },
  { code: 'MM', name: '樂桃航空' },
  { code: 'IT', name: '台灣虎航' },
  { code: 'JX', name: '星宇航空' },
  { code: '7C', name: '濟州航空' },
  { code: 'VN', name: '越南航空' },
  { code: 'NU', name: '日本越洋航空' },
  { code: 'GK', name: '捷星日本航空' },
  { code: 'PR', name: '菲律賓航空' },
  { code: 'SL', name: '泰獅航空' },
  { code: 'CI', name: '中華航空' },
  { code: 'CX', name: '國泰航空' },
  { code: 'UO', name: '香港快運航空' },
  { code: 'TW', name: '泰瑞航空' },
  { code: 'UA', name: '聯合航空' },
  { code: 'TG', name: '泰國航空' },
  { code: 'AK', name: '馬來西亞亞洲航空' },
  { code: 'FD', name: '泰國亞洲航空' },
  { code: '5J', name: '宿霧太平洋航空' },
  { code: 'Z2', name: '菲律賓亞洲航空' },
] as const;
export const taoyuanAirlines = activeAirlines.filter((a) =>
  ['BR', 'MM', 'IT', 'JX', '7C', 'VN', 'NU', 'GK', 'PR', 'SL', 'CI'].includes(a.code),
);
export const activeAirlineNames = taoyuanAirlines
  .map((airline) => airline.name)
  .join('、');

export function findActiveAirline(query: string) {
  const key = query.normalize('NFKC').replace(/[\s-]/g, '').toLowerCase();
  return activeAirlines.find(
    (airline) =>
      airline.code.toLowerCase() === key || airline.name.toLowerCase() === key,
  );
}

export function isActiveAirline(
  flight: Pick<Flight, 'airlineCode' | 'number' | 'origin'>,
) {
  return (
    (flight.origin === 'KHH' ? activeAirlines : taoyuanAirlines).some(
      (airline) => airline.code === flight.airlineCode,
    ) && new RegExp(`^${flight.airlineCode}\\d+[A-Z]?$`).test(flight.number)
  );
}
