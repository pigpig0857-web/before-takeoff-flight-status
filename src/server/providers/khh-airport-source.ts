import type { SavedFlight } from './collected';
import { arrivalAirport } from '@/features/flights/destinations';

export const khhAirportRoutes: Record<string, readonly string[]> = {
  CI: ['NRT', 'KIX', 'ICN', 'HKG', 'BKK', 'MNL'],
  CX: ['HKG'],
  UO: ['HKG'],
  TW: ['ICN'],
  UA: ['NRT'],
  TG: ['BKK'],
  AK: ['KIX', 'KUL'],
  FD: ['NRT'],
  '5J': ['MNL'],
  Z2: ['MNL'],
};
const kiaDates: Record<string, string[]> = {
  CI102: ['2026-10-20', '2026-10-21', '2026-10-23', '2026-10-24'],
  CI933: ['2026-10-20', '2026-10-21', '2026-10-23'],
  CI164: ['2026-10-21', '2026-10-23'],
  CI166: ['2026-10-21', '2026-10-23'],
  CI126: ['2026-10-24'],
};
export function validateKhhAirportRecord(r: SavedFlight) {
  const p = r.evidence;
  const airport = r.airport && arrivalAirport(r.airport);
  const kia = r.kind === 'collected_khh_airport';
  const url = kia
    ? 'https://www.kia.gov.tw/data/flightplan.json'
    : 'https://www.kansai-airport.or.jp/tw/flight/schedule';
  if (
    r.origin !== 'KHH' ||
    r.date < '2026-10-20' ||
    r.date > '2026-12-31' ||
    !airport ||
    !khhAirportRoutes[r.number.slice(0, 2)]?.includes(r.airport!) ||
    r.countryCode !== airport.countryCode ||
    r.url !== url ||
    r.label !==
      (kia ? '高雄國際航空站官網公布班表' : '關西機場公開預定班表（OAG）') ||
    r.terminal !== null ||
    r.arrivalTerminal !== null ||
    r.aircraft !== null ||
    r.operatingAirline !== null ||
    r.operatingNumber !== null ||
    r.codeshare !== null ||
    r.page !== null ||
    r.detail ||
    r.continuationAirport ||
    r.candidateAirport !== null ||
    !r.sourceNotice ||
    !p?.file ||
    !/^[a-f0-9]{64}$/.test(p.sha256) ||
    p.sourceUrl !== (kia ? url : url + '?ajax_form=1') ||
    (r.number === 'UA838' && r.date <= '2026-10-24') ||
    (kia
      ? !kiaDates[r.number]?.includes(r.date) ||
        !Number.isInteger(p.rowIndex) ||
        p.rowIndex! < 0 ||
        p.file !==
          'data/source-samples/crawler/khh-expansion-20261020/probes/kia.body'
      : !Number.isInteger(p.cardIndex) ||
        p.cardIndex! < 0 ||
        p.query?.origin !== 'KHH' ||
        p.query.airport !== r.airport ||
        p.query.date !== r.date ||
        !/^data\/source-samples\/crawler\/(khh-more-airlines-20261020|destination-expansion-20261016|airline-completeness-20261016|new-airlines-20261016)\/.+\.body$/.test(
          p.file,
        ))
  )
    throw new Error('Unreviewed KHH airport timetable record');
}
