import type { Flight, FlightStatus } from '@/features/flights/types';
import { validDate } from '@/lib/time';
export const SOURCE_URLS = {
  realtime: 'https://odp.taoyuan-airport.com/dataset/2025102001?format=csv',
  schedule: 'https://odp.taoyuan-airport.com/dataset/2025092301?format=csv',
};
export const SOURCE_PAGES = {
  realtime: 'https://data.gov.tw/dataset/177644',
  schedule: 'https://data.gov.tw/dataset/177643',
};
type Row = Record<string, string>;
function clean(value: string | undefined): string | null {
  const result = value?.trim();
  return !result || /^(null|undefined|nan)$/i.test(result) ? null : result;
}
function required(rows: Row[], headers: string[]) {
  if (!rows.length || headers.some((key) => !(key in rows[0])))
    throw new Error('官方資料缺少必要欄位');
}
function timestamp(
  dateValue: string | undefined,
  timeValue: string | undefined,
): string | null {
  const date = dateValue?.slice(0, 10) || '';
  const time = timeValue?.match(/^(\d{2}:\d{2}:\d{2})/)?.[1];
  if (
    !validDate(date) ||
    !time ||
    !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)
  )
    return null;
  return `${date}T${time}+08:00`;
}
export function deriveStatus(
  raw: string,
  scheduled: string,
  reported: string | null,
  future: boolean,
): FlightStatus {
  if (/取消|cancel/i.test(raw)) return 'cancelled';
  if (future) return 'scheduled';
  if (/已飛|flew|departed/i.test(raw) || /(^| · )出發($| · )/.test(raw))
    return 'departed';
  if (/登機|boarding/i.test(raw)) return 'boarding';
  if (/延誤|delay/i.test(raw)) return 'delayed';
  if (/變更|異動|change/i.test(raw)) {
    return reported &&
      new Date(reported).getTime() > new Date(scheduled).getTime()
      ? 'delayed'
      : 'changed';
  }
  return 'unconfirmed';
}
export function normalizeRealtime(rows: Row[], today: string): Flight[] {
  required(rows, [
    '方向',
    '航廈',
    '航空公司代碼',
    '班次',
    '表訂日期',
    '表訂時間',
    '往來地點',
  ]);
  const flights = new Map<string, Flight>();
  for (const row of rows) {
    // The passenger feed uses T1/T2. Unrecognized terminals are deliberately excluded.
    if (row['方向'] !== 'D' || !['T1', 'T2'].includes(row['航廈'])) continue;
    const scheduled = timestamp(row['表訂日期'], row['表訂時間']);
    const airlineCode = clean(row['航空公司代碼']);
    const numeric = clean(row['班次']);
    const destinationCode = clean(row['往來地點']);
    if (
      !scheduled ||
      !airlineCode ||
      !numeric ||
      !destinationCode ||
      !/^[A-Z0-9]{2}$/.test(airlineCode) ||
      !/^\d+[A-Z]?$/.test(numeric)
    )
      continue;
    const number = `${airlineCode}${numeric.replace(/^0+(?=\d)/, '')}`;
    const date = scheduled.slice(0, 10);
    const reported = timestamp(row['預計日期'], row['預計時間']);
    const sourceStatus = [
      clean(row['航班動態中文']),
      clean(row['備註']),
      clean(row['航班動態英文']),
    ]
      .filter(Boolean)
      .join(' · ');
    const status = deriveStatus(
      sourceStatus,
      scheduled,
      reported,
      date > today,
    );
    const id = `${date}-${number}-TPE-${destinationCode}-${scheduled.slice(11, 16).replace(':', '')}`;
    flights.set(id, {
      id,
      number,
      airlineCode,
      airline: clean(row['航空公司中文']) || airlineCode,
      date,
      scheduledDeparture: scheduled,
      reportedDeparture: reported,
      reportedTimeKind: status === 'departed' ? 'actual' : 'estimated',
      destinationCode,
      destination: clean(row['往來地點中文']) || destinationCode,
      destinationEnglish: clean(row['往來地點英文']) || '',
      terminal: row['航廈'],
      gate: clean(row['機門']),
      counter: clean(row['報到櫃台']),
      aircraft: clean(row['機型']),
      status,
      sourceStatus,
      source: 'realtime',
    });
  }
  return [...flights.values()];
}
export function normalizeSchedule(
  rows: Row[],
  passengerReference: Flight[],
): Flight[] {
  required(rows, [
    '飛行日期',
    '航空公司',
    '航班號',
    '出發地',
    '表訂起飛時間',
    '目的地',
  ]);
  // Schedule feed mixes cargo/private/other airports and has no passenger flag.
  // Only admit flight numbers positively identified in the passenger feed.
  const passenger = new Map(passengerReference.map((f) => [f.number, f]));
  const flights = new Map<string, Flight>();
  for (const row of rows) {
    if (row['出發地'] !== 'TPE') continue;
    const number = (clean(row['航班號']) || '')
      .replace(/\s/g, '')
      .replace(/^([A-Z0-9]{2})0+(?=\d)/, '$1');
    const reference = passenger.get(number);
    const iso = clean(row['表訂起飛時間']);
    if (!reference || !iso || !Number.isFinite(Date.parse(iso))) continue;
    const instant = new Date(iso);
    const taipeiIso = new Date(instant.getTime() + 8 * 3600000).toISOString();
    const scheduled = `${taipeiIso.slice(0, 19)}+08:00`;
    const date = scheduled.slice(0, 10);
    const destinationCode = clean(row['目的地']);
    if (!destinationCode || date !== row['飛行日期'].slice(0, 10)) continue;
    const id = `${date}-${number}-TPE-${destinationCode}-${scheduled.slice(11, 16).replace(':', '')}`;
    flights.set(id, {
      ...reference,
      id,
      date,
      scheduledDeparture: scheduled,
      reportedDeparture: null,
      reportedTimeKind: 'estimated',
      destinationCode,
      destination:
        destinationCode === reference.destinationCode
          ? reference.destination
          : destinationCode,
      destinationEnglish:
        destinationCode === reference.destinationCode
          ? reference.destinationEnglish
          : '',
      terminal: null,
      gate: null,
      counter: null,
      aircraft: null,
      status: 'scheduled',
      sourceStatus: '定期班表，可能異動',
      source: 'schedule',
    });
  }
  return [...flights.values()];
}
