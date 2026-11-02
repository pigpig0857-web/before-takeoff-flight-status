import type {
  Flight,
  FeedInfo,
  CollectedDetail,
  CollectedSourceKind,
} from '@/features/flights/types';
import { arrivalAirport } from '@/features/flights/destinations';
import { validDate, validTime } from '@/lib/time';
import { philippinePDFs } from './philippine-source';
import { validateKhhAirportRecord } from './khh-airport-source';

// Reuse the IANA formatter across records and requests; date-specific DST is
// still applied by formatToParts for each instant.
const arrivalFormatters = new Map<string, Intl.DateTimeFormat>();
function arrivalFormatter(timeZone: string) {
  let formatter = arrivalFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    arrivalFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export interface SavedFlight {
  origin?: 'TPE' | 'KHH';
  number: string;
  airline: string;
  date: string;
  departure: string;
  arrival: string;
  arrivalTimeZone: string;
  airport: string | null;
  candidateAirport: string | null;
  destination: string;
  destinationEnglish: string;
  countryCode: string | null;
  terminal: string | null;
  arrivalTerminal: string | null;
  aircraft: string | null;
  minutes: number;
  kind: CollectedSourceKind;
  label: string;
  url: string;
  fetchedAt: string;
  operatingAirline: string | null;
  operatingNumber: string | null;
  codeshare: boolean | null;
  page: number | null;
  sourcePublishedAt?: string;
  sourceNotice?: string;
  terminalReference?: NonNullable<Flight['collected']>['terminalReference'];
  evidence?: {
    file: string;
    sha256: string;
    sourceUrl: string;
    ruleIndexes?: number[];
    rowIndex?: number;
    tableIndex?: number;
    lineIndex?: number;
    cardIndex?: number;
    query?: { origin: 'TPE' | 'KHH'; airport: string; date: string };
  };
  detail?: CollectedDetail;
  continuationAirport?: string;
}
export interface CollectedSnapshot {
  version: number;
  importedAt: string;
  records: SavedFlight[];
  coverage: {
    kind: CollectedSourceKind;
    label: string;
    url: string;
    fetchedAt: string;
    description: string;
    dates: string[];
    records: number;
  }[];
}
export function normalizeCollected(record: SavedFlight): Flight {
  if (record.origin && record.origin !== 'TPE' && record.origin !== 'KHH')
    throw new Error('Unsupported departure airport');
  if (
    record.origin === 'KHH' &&
    ![
      'collected_tigerair',
      'collected_peach',
      'collected_jetstar',
      'collected_jeju',
      'collected_eva',
      'collected_vietnam',
      'collected_lion',
      'collected_khh_oag',
      'collected_khh_airport',
    ].includes(record.kind)
  )
    throw new Error('Unreviewed Kaohsiung source');
  if (
    record.origin === 'KHH' &&
    ['collected_peach', 'collected_jetstar'].includes(record.kind)
  ) {
    const peach = record.kind === 'collected_peach';
    const winter = record.date >= '2026-10-25';
    if (
      record.date < '2026-10-15' ||
      record.date > '2026-12-31' ||
      (peach
        ? record.number !== 'MM032' || record.airport !== 'KIX'
        : !(
            (record.number === 'GK18' && record.airport === 'NRT') ||
            (record.number === 'GK98' && record.airport === 'OKA')
          )) ||
      record.page !== 1 ||
      !record.evidence?.file ||
      !/^[a-f0-9]{64}$/.test(record.evidence.sha256) ||
      record.evidence.sourceUrl !== record.url ||
      (peach && !Number.isInteger(record.evidence.rowIndex)) ||
      record.sourcePublishedAt !==
        (peach
          ? winter
            ? '2026-09-16'
            : '2026-07-06'
          : winter
            ? '2026-09-09'
            : '2026-02-03')
    )
      throw new Error('Unreviewed Kaohsiung PDF record');
  }
  const code = record.number.slice(0, 2);
  if (
    record.origin === 'KHH' &&
    ['collected_eva', 'collected_vietnam'].includes(record.kind)
  ) {
    const proof = record.evidence;
    if (
      record.date < '2026-10-20' ||
      record.date > '2026-12-31' ||
      !(
        record.kind === 'collected_eva'
          ? ['FUK', 'HKG', 'ICN', 'KIX', 'MFM', 'NRT', 'PVG']
          : ['HAN', 'SGN']
      ).includes(record.airport || '') ||
      proof?.query?.origin !== 'KHH' ||
      proof.query.airport !== record.airport ||
      proof.query.date !== record.date ||
      !proof.file ||
      !/^[a-f0-9]{64}$/.test(proof.sha256) ||
      record.terminal !== null ||
      record.arrivalTerminal !== null ||
      record.aircraft !== null ||
      record.detail
    )
      throw new Error('Unreviewed Kaohsiung BR/VN evidence');
  }
  if (
    !/^[A-Z0-9]{2}\d+[A-Z]?$/.test(record.number) ||
    !validDate(record.date) ||
    record.departure.slice(0, 10) !== record.date ||
    !validTime(record.departure.slice(11, 16)) ||
    !record.departure.endsWith('+08:00') ||
    !Number.isFinite(Date.parse(record.fetchedAt))
  )
    throw new Error('Invalid collected identity');
  const departure = Date.parse(record.departure),
    arrival = Date.parse(record.arrival);
  if (
    !Number.isFinite(arrival) ||
    !Number.isFinite(departure) ||
    (arrival - departure) / 60000 !== record.minutes ||
    record.minutes <= 0 ||
    record.minutes > 1440
  )
    throw new Error('Invalid collected duration');
  if (record.airport && !arrivalAirport(record.airport))
    throw new Error('Unknown collected airport');
  if (
    ![
      'collected_ci',
      'collected_trip',
      'collected_eva',
      'collected_peach',
      'collected_tigerair',
      'collected_starlux',
      'collected_jeju',
      'collected_vietnam',
      'collected_jta',
      'collected_jetstar',
      'collected_kix',
      'collected_philippine',
      'collected_lion',
      'collected_khh_oag',
      'collected_khh_airport',
    ].includes(record.kind) ||
    !record.airline ||
    !record.destination
  )
    throw new Error('Invalid collected source');
  if (
    record.kind === 'collected_khh_oag' ||
    record.kind === 'collected_khh_airport'
  ) {
    validateKhhAirportRecord(record);
  } else if (record.kind === 'collected_lion') {
    const proof = record.evidence;
    const origin = record.origin || 'TPE';
    const airport = record.airport && arrivalAirport(record.airport);
    if (
      !airport ||
      record.countryCode !== airport.countryCode ||
      record.airline !== '泰獅航空' ||
      !/^SL\d{3}$/.test(record.number) ||
      record.operatingAirline !== record.airline ||
      record.operatingNumber !== record.number ||
      record.codeshare !== false ||
      record.date < '2026-10-20' ||
      record.date > '2026-10-31' ||
      !(origin === 'TPE' ? ['OKA'] : ['OKA', 'CTS', 'DMK']).includes(
        record.airport || '',
      ) ||
      !proof?.file ||
      !/^[a-f0-9]{64}$/.test(proof.sha256) ||
      !Number.isInteger(proof.rowIndex) ||
      proof.query?.origin !== origin ||
      proof.query.airport !== record.airport ||
      proof.query.date !== record.date ||
      ![
        'https://www.naha-airport.co.jp/common/json/arrival_flight_schedule.json',
        'https://www.hokkaido-airports.com/api/v1/new-chitose/static/schedule/international.json',
        'https://www.kia.gov.tw/data/flightplan.json',
      ].includes(proof.sourceUrl) ||
      record.url !== proof.sourceUrl ||
      record.terminal !== null ||
      record.arrivalTerminal !== null ||
      record.aircraft !== null ||
      record.detail ||
      record.continuationAirport ||
      !record.sourceNotice
    )
      throw new Error(
        'Invalid Thai Lion airport evidence or unsupported scope',
      );
  } else if (record.kind === 'collected_philippine') {
    const proof = record.evidence;
    const pdf = philippinePDFs.find((s) => s.url === record.url);
    if (
      !pdf ||
      record.date < pdf.from ||
      record.date > pdf.through ||
      record.date < '2026-10-15' ||
      record.date > '2026-12-31' ||
      !/^PR\d{1,4}$/.test(record.number) ||
      record.airline !== '菲律賓航空' ||
      record.airport !== 'MNL' ||
      record.countryCode !== 'PH' ||
      record.arrivalTimeZone !== 'Asia/Manila' ||
      !record.arrival.endsWith('+08:00') ||
      record.candidateAirport !== null ||
      record.terminal !== null ||
      record.arrivalTerminal !== null ||
      record.aircraft !== null ||
      record.operatingAirline !== null ||
      record.operatingNumber !== null ||
      record.codeshare !== null ||
      record.terminalReference ||
      record.detail ||
      record.continuationAirport ||
      record.label !== '菲律賓航空官方公布班表' ||
      record.sourcePublishedAt !== '2026-10-09' ||
      record.page !== pdf.page ||
      !proof?.file ||
      !/^[a-f0-9]{64}$/.test(proof.sha256) ||
      proof.sourceUrl !== record.url ||
      !Number.isInteger(proof.rowIndex) ||
      proof.rowIndex! < 0
    )
      throw new Error(
        'Invalid Philippine published schedule evidence or unsupported metadata',
      );
  } else if (record.kind === 'collected_eva') {
    const source = new URL(record.url);
    if (
      source.origin !== 'https://booking.evaair.com' ||
      source.pathname.toLowerCase() !==
        '/flyeva/eva/b2c/flight-schedules.aspx' ||
      !/^BR\d+$/.test(record.number) ||
      record.codeshare ||
      record.operatingAirline !== '長榮航空'
    )
      throw new Error('Unexpected EVA collected source or operator');
    if (record.detail) {
      const detailUrl = new URL(record.detail.url);
      if (
        detailUrl.origin !== source.origin ||
        detailUrl.pathname.toLowerCase() !==
          '/flyeva/eva/b2c/flight-details.aspx' ||
        detailUrl.searchParams.get('Week_DT') !==
          `${record.date.slice(5, 7)}/${record.date.slice(8, 10)}/${record.date.slice(0, 4)}` ||
        !Number.isFinite(Date.parse(record.detail.fetchedAt)) ||
        record.detail.scope !== 'segment' ||
        record.detail.nonstop !== true ||
        record.detail.departureTerminal !== record.terminal ||
        record.detail.arrivalTerminal !== record.arrivalTerminal ||
        record.detail.aircraft !== record.aircraft
      )
        throw new Error('Invalid collected detail evidence');
    }
    if (
      record.continuationAirport &&
      !arrivalAirport(record.continuationAirport)
    )
      throw new Error('Unknown continuation airport');
  } else if (record.kind === 'collected_peach') {
    const source = new URL(record.url);
    if (
      source.origin !== 'https://www.flypeach.com' ||
      !/^\/application\/files\/\d+\/\d+\/\d+\/\d{8}_[SW]\d{2}_\d{8}-\d{8}_int_EN\.pdf$/.test(
        source.pathname,
      ) ||
      source.search ||
      source.hash ||
      !/^MM\d{1,4}$/.test(record.number) ||
      record.airline !== '樂桃航空' ||
      record.operatingAirline !== '樂桃航空' ||
      record.operatingNumber !== record.number ||
      record.codeshare ||
      record.detail ||
      record.continuationAirport ||
      !['KIX', 'NRT', 'HND', 'NGO', 'OKA'].includes(record.airport || '') ||
      record.arrivalTimeZone !== 'Asia/Tokyo' ||
      record.countryCode !== 'JP' ||
      record.terminal !== null ||
      record.arrivalTerminal !== null ||
      record.aircraft !== null ||
      !record.sourcePublishedAt ||
      !validDate(record.sourcePublishedAt)
    )
      throw new Error(
        'Unexpected Peach collected source or unsupported details',
      );
  } else if (record.kind === 'collected_ci' &&
    ['https://booking.china-airlines.com', 'https://www.kansai-airport.or.jp'].includes(new URL(record.url).origin)) {
    const source = new URL(record.url);
    if (!record.number.startsWith('CI') || !record.evidence?.file ||
      !/^[a-f0-9]{64}$/.test(record.evidence.sha256) || record.evidence.sourceUrl !== record.url ||
      !['/Flightschedule/', '/tw/flight/schedule'].includes(source.pathname))
      throw new Error('Invalid CI official timetable evidence');
  } else if (
    record.kind === 'collected_tigerair' ||
    record.kind === 'collected_starlux'
  ) {
    const tiger = record.kind === 'collected_tigerair';
    const source = new URL(record.url);
    const evidence = record.evidence;
    const rawSource = evidence && new URL(evidence.sourceUrl);
    const airport = record.airport && arrivalAirport(record.airport);
    if (
      !airport ||
      airport.countryCode !== record.countryCode ||
      record.candidateAirport ||
      record.codeshare ||
      record.airline !== (tiger ? '台灣虎航' : '星宇航空') ||
      record.operatingAirline !== record.airline ||
      record.operatingNumber !== record.number ||
      !new RegExp(`^${tiger ? 'IT' : 'JX'}\\d{1,4}$`).test(record.number) ||
      record.detail ||
      record.continuationAirport ||
      !evidence ||
      !/^[a-f0-9]{64}$/.test(evidence.sha256) ||
      !evidence.file ||
      (record.terminal !== null && !['T1', 'T2'].includes(record.terminal))
    )
      throw new Error('Invalid new airline identity/evidence');
    if (tiger) {
      if (
        source.href !==
          'https://www.tigerairtw.com/zh-TW/ready-to-go/flight-schedule' ||
        rawSource?.href !==
          'https://api-cms.tigerairtw.com/api/flight-schedules/merge' ||
        !evidence.ruleIndexes?.length ||
        evidence.ruleIndexes.some((i) => !Number.isInteger(i) || i < 0) ||
        record.terminal !== null ||
        record.arrivalTerminal !== null ||
        record.aircraft !== null
      )
        throw new Error('Invalid Tigerair source or unsupported details');
    } else if (
      source.origin !== 'https://www.starlux-airlines.com' ||
      source.pathname !== '/zh-TW/timetable/search-result' ||
      source.searchParams.get('depAirport') !== 'TPE' ||
      source.searchParams.get('arrAirport') !== record.airport ||
      source.searchParams.get('date') !== record.date ||
      source.hash ||
      rawSource?.origin !== 'https://ecapi.starlux-airlines.com' ||
      rawSource.pathname !== '/flightSchedule/v2/timetable' ||
      rawSource.searchParams.get('depAirport') !== 'TPE' ||
      rawSource.searchParams.get('arrAirport') !== record.airport ||
      !validDate(rawSource.searchParams.get('date') || '') ||
      Math.abs(
        Date.parse(record.date) -
          Date.parse(rawSource.searchParams.get('date')!),
      ) >
        3 * 86400_000 ||
      !Number.isInteger(evidence.rowIndex) ||
      evidence.rowIndex! < 0
    )
      throw new Error('Invalid Starlux source evidence');
  } else if (
    record.kind === 'collected_jeju' ||
    record.kind === 'collected_vietnam'
  ) {
    const jeju = record.kind === 'collected_jeju';
    const source = new URL(record.url);
    const proof = record.evidence;
    const raw = proof && new URL(proof.sourceUrl);
    const airport = record.airport && arrivalAirport(record.airport);
    const query = proof?.query;
    if (
      !airport ||
      airport.countryCode !== record.countryCode ||
      ![
        ...(jeju
          ? record.origin === 'KHH'
            ? ['GMP', 'PUS']
            : ['ICN', 'PUS']
          : ['HAN', 'SGN']),
      ].includes(record.airport || '') ||
      record.countryCode !== (jeju ? 'KR' : 'VN') ||
      record.arrivalTimeZone !== (jeju ? 'Asia/Seoul' : 'Asia/Ho_Chi_Minh') ||
      !new RegExp(`^${jeju ? '7C' : 'VN'}\\d{1,4}$`).test(record.number) ||
      record.airline !== (jeju ? '濟州航空' : '越南航空') ||
      record.operatingAirline !== record.airline ||
      record.operatingNumber !== null ||
      record.codeshare ||
      record.candidateAirport ||
      record.continuationAirport ||
      !proof ||
      !proof.file ||
      !/^[a-f0-9]{64}$/.test(proof.sha256) ||
      !Number.isInteger(proof.rowIndex) ||
      proof.rowIndex! < 0 ||
      !query ||
      query.origin !== (record.origin || 'TPE') ||
      query.airport !== record.airport ||
      !validDate(query.date) ||
      Math.abs(Date.parse(record.date) - Date.parse(query.date)) >
        (jeju ? 3 : 0) * 86400_000
    )
      throw new Error('Invalid Jeju/Vietnam identity or evidence');
    if (jeju) {
      if (
        (record.origin === 'KHH' &&
          (record.date < '2026-10-16' ||
            record.date > '2026-12-31' ||
            (record.airport === 'GMP'
              ? !['7C6124', '7C6122'].includes(record.number)
              : record.number !== '7C6256'))) ||
        source.href !==
          'https://www.jejuair.net/en/prepare/flight/viewScheduleInfo.do' ||
        raw?.href !==
          'https://www.jejuair.net/en/prepare/flight/getFlightSchedule.json' ||
        record.aircraft !== null ||
        record.terminal !== null ||
        record.arrivalTerminal !== null
      )
        throw new Error('Invalid Jeju source or unsupported metadata');
    } else if (
      source.origin !== 'https://www.vietnamairlines.com' ||
      source.pathname !== '/vn/en/flightschedule' ||
      source.searchParams.get('originLocationCode') !==
        (record.origin || 'TPE') ||
      source.searchParams.get('destinationLocationCode') !== record.airport ||
      source.searchParams.get('departureDate') !== record.date ||
      source.hash ||
      raw?.origin !==
        'https://integration-middleware-website.vietnamairlines.com' ||
      raw.pathname !== '/api/v1/public/flight/schedule-table' ||
      raw.searchParams.get('originLocationCode') !== (record.origin || 'TPE') ||
      raw.searchParams.get('destinationLocationCode') !== record.airport ||
      raw.searchParams.get('departureDate') !== record.date ||
      (record.terminal !== null && !['T1', 'T2'].includes(record.terminal))
    )
      throw new Error('Invalid Vietnam source evidence');
    if (
      record.detail &&
      (record.detail.url !== record.url ||
        record.detail.fetchedAt !== record.fetchedAt ||
        record.detail.scope !== 'segment' ||
        record.detail.nonstop !== true ||
        record.detail.departureTerminal !== record.terminal ||
        record.detail.arrivalTerminal !== record.arrivalTerminal ||
        record.detail.aircraft !== record.aircraft)
    )
      throw new Error('Invalid Jeju/Vietnam detail evidence');
  } else if (
    ['collected_jta', 'collected_jetstar', 'collected_kix'].includes(
      record.kind,
    )
  ) {
    const jta = record.kind === 'collected_jta';
    const airportSource = record.kind === 'collected_kix';
    const proof = record.evidence;
    const source = new URL(record.url);
    const expectedSource = jta
      ? 'https://www.jal.co.jp/tw/en/offers/okinawa-jta/'
      : airportSource
        ? 'https://www.kansai-airport.or.jp/tw/flight/schedule'
        : null;
    const pdfs = [
      'https://files.jetstar.com/api/public/content/gk_jq_timetable_26nsint',
      'https://files.jetstar.com/api/public/content/gk_jq_timetable_26nwint',
    ];
    if (
      (expectedSource
        ? source.href !== expectedSource
        : !pdfs.includes(source.href)) ||
      !new RegExp(`^${jta ? 'NU' : 'GK'}\\d{1,4}$`).test(record.number) ||
      record.airline !== (jta ? '日本越洋航空' : '捷星日本航空') ||
      record.operatingAirline !== record.airline ||
      record.operatingNumber !== null ||
      record.codeshare ||
      record.candidateAirport ||
      record.continuationAirport ||
      record.detail ||
      record.countryCode !== 'JP' ||
      record.arrivalTimeZone !== 'Asia/Tokyo' ||
      ![
        ...(jta
          ? ['OKA']
          : airportSource
            ? ['KIX']
            : record.origin === 'KHH'
              ? ['NRT', 'OKA']
              : ['KIX', 'NRT']),
      ].includes(record.airport || '') ||
      record.date < '2026-10-14' ||
      record.date > '2026-12-31' ||
      record.terminal !==
        (record.origin === 'KHH' ? 'INT' : jta ? 'T2' : 'T1') ||
      record.arrivalTerminal !==
        (jta
          ? null
          : record.airport === 'NRT'
            ? '3'
            : record.origin === 'KHH'
              ? 'INT'
              : '1') ||
      record.aircraft !== (jta ? 'Boeing 737-800' : null) ||
      !proof?.file ||
      !/^[a-f0-9]{64}$/.test(proof.sha256) ||
      proof.sourceUrl !==
        (airportSource ? `${expectedSource}?ajax_form=1` : record.url) ||
      (jta
        ? !Number.isInteger(proof.tableIndex) ||
          !Number.isInteger(proof.rowIndex)
        : airportSource
          ? !Number.isInteger(proof.cardIndex) ||
            proof.query?.origin !== 'TPE' ||
            proof.query.airport !== 'KIX' ||
            proof.query.date !== record.date
          : !Number.isInteger(proof.lineIndex) ||
            !record.sourcePublishedAt ||
            !validDate(record.sourcePublishedAt))
    )
      throw new Error(
        'Invalid JTA/Jetstar/airport schedule evidence or unsupported metadata',
      );
    const reference = record.terminalReference;
    if (
      !reference ||
      !Number.isFinite(Date.parse(reference.fetchedAt)) ||
      (jta
        ? reference.basis !== 'published_airline_airport_guide' ||
          reference.url !==
            'https://www.jal.co.jp/jp/ja/inter/airport/tpe/info/'
        : reference.basis !== 'published_timetable_route_header' ||
          !pdfs.includes(reference.url))
    )
      throw new Error('Invalid terminal reference');
    if (airportSource && record.label !== '關西機場公開預定班表（OAG）')
      throw new Error('Airport timetable must retain its source attribution');
  } else if (
    ![
      'https://cms-externalcontent-prod.s3.ap-northeast-1.amazonaws.com',
      'https://tw.trip.com',
    ].includes(new URL(record.url).origin)
  )
    throw new Error('Unexpected collected source URL');
  // Also ensure the saved local arrival actually agrees with its IANA zone.
  const parts = arrivalFormatter(record.arrivalTimeZone).formatToParts(arrival);
  const wall = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  if (
    `${wall.year}-${wall.month}-${wall.day}T${wall.hour}:${wall.minute}` !==
    record.arrival.slice(0, 16)
  )
    throw new Error('Collected arrival zone mismatch');
  return {
    origin: record.origin || 'TPE',
    id: `${record.origin === 'KHH' ? 'KHH-' : ''}${record.kind}-${record.date}-${record.number}-${record.airport || record.destinationEnglish}-${record.departure.slice(11, 16)}`,
    number: record.number,
    airlineCode: code,
    airline: record.airline,
    date: record.date,
    scheduledDeparture: record.departure,
    reportedDeparture: null,
    reportedTimeKind: 'estimated',
    destinationCode: record.airport || '',
    destination: record.destination,
    destinationEnglish: record.destinationEnglish,
    terminal: record.terminal,
    gate: null,
    counter: null,
    aircraft: record.aircraft,
    status: 'scheduled',
    sourceStatus: '已保存的預定班表，非即時動態',
    source: record.kind,
    scheduledArrival: record.arrival,
    arrivalTimeZone: record.arrivalTimeZone,
    arrivalTerminal: record.arrivalTerminal,
    durationMinutes: record.minutes,
    collected: {
      label: record.label,
      url: record.url,
      fetchedAt: record.fetchedAt,
      countryCode: record.countryCode,
      candidateAirport: record.candidateAirport,
      airportConfirmed: Boolean(record.airport),
      operatingAirline: record.operatingAirline,
      operatingNumber: record.operatingNumber,
      codeshare: record.codeshare,
      sourcePage: record.page,
      ...(record.sourcePublishedAt && {
        sourcePublishedAt: record.sourcePublishedAt,
      }),
      ...(record.detail && { detail: record.detail }),
      ...(record.continuationAirport && {
        continuationAirport: record.continuationAirport,
      }),
      ...(record.sourceNotice && { sourceNotice: record.sourceNotice }),
      ...(record.terminalReference && {
        terminalReference: record.terminalReference,
      }),
    },
  };
}
export function collectedDataset(
  snapshot: CollectedSnapshot,
  today: string,
  now = Date.now(),
): { flights: Flight[]; feeds: FeedInfo[] } {
  if (snapshot.version !== 1) throw new Error('Unsupported collected snapshot');
  const flights = snapshot.records
    .filter((r) => r.date >= today)
    .map(normalizeCollected);
  const feeds = snapshot.coverage.map((c) => {
    const stale = now - Date.parse(c.fetchedAt) > 24 * 3600_000;
    return {
      kind: c.kind,
      label: c.label,
      url: c.url,
      fetchedAt: c.fetchedAt,
      sourceUpdatedAt: null,
      dates: c.dates.filter((d) => d >= today),
      state: stale ? ('stale' as const) : ('ready' as const),
      partial: true,
      coverageDescription: c.description,
      warning: stale
        ? '已保存資料超過一天，尚未重新核對；航班安排可能變更。'
        : '只涵蓋已收集的航空公司、目的地與日期，非完整航班清單。',
    };
  });
  return { flights, feeds };
}
function sameNumber(a: string, b: string) {
  return (
    a.replace(/^([A-Z0-9]{2})0+(?=\d)/, '$1') ===
    b.replace(/^([A-Z0-9]{2})0+(?=\d)/, '$1')
  );
}
/** New official EVA tables supersede earlier booking-site snapshots of the same service. */
export function preferOfficialEva(saved: Flight[], eva: Flight[]): Flight[] {
  return [
    ...saved.filter(
      (f) =>
        !eva.some(
          (e) =>
            e.date === f.date &&
            (e.origin || 'TPE') === (f.origin || 'TPE') &&
            sameNumber(e.number, f.number) &&
            e.destinationCode ===
              (f.destinationCode || f.collected?.candidateAirport),
        ),
    ),
    ...eva,
  ];
}
export function mergeCollectedFlights(
  primary: Flight[],
  saved: Flight[],
): Flight[] {
  const remaining = [...saved];
  const merged = primary.map((f) => {
    const index = remaining.findIndex(
      (s) =>
        s.date === f.date &&
        (s.origin || 'TPE') === (f.origin || 'TPE') &&
        sameNumber(s.number, f.number) &&
        (s.destinationCode === f.destinationCode ||
          (!s.destinationCode &&
            s.collected?.candidateAirport === f.destinationCode)),
    );
    if (index < 0) return f;
    const s = remaining.splice(index, 1)[0];
    // Keep live status/time/locations authoritative. A changed departure cannot
    // inherit the older arrival estimate, even if the flight number agrees.
    if (Date.parse(f.scheduledDeparture) !== Date.parse(s.scheduledDeparture))
      return f;
    return {
      ...s,
      ...f,
      scheduledArrival: f.scheduledArrival || s.scheduledArrival,
      arrivalTimeZone: f.arrivalTimeZone || s.arrivalTimeZone,
      arrivalTerminal: f.arrivalTerminal || s.arrivalTerminal,
      durationMinutes: f.durationMinutes || s.durationMinutes,
      aircraft: f.aircraft || s.aircraft,
      collected: s.collected,
    };
  });
  return [...merged, ...remaining];
}
