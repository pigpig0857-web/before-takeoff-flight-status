import type { FeedInfo, Flight, FlightDataset } from '@/features/flights/types';
import {
  activeAirlineNames,
  isActiveAirline,
} from '@/features/flights/airline-scope';
import { taipeiDate } from '@/lib/time';
import { parseCsv } from '../providers/csv';
import {
  normalizeRealtime,
  normalizeSchedule,
  SOURCE_PAGES,
  SOURCE_URLS,
} from '../providers/taoyuan';
import { demoFlights } from '../providers/demo';
import { createCache } from './cache';
import evaSnapshot from '../data/eva-flights.json';
import peachSnapshot from '../data/peach-flights.json';
import tigerairSnapshot from '../data/tigerair-flights.json';
import starluxSnapshot from '../data/starlux-flights.json';
import jejuSnapshot from '../data/jeju-flights.json';
import vietnamSnapshot from '../data/vietnam-flights.json';
import jtaSnapshot from '../data/jta-flights.json';
import jetstarSnapshot from '../data/jetstar-flights.json';
import philippineSnapshot from '../data/philippine-flights.json';
import kaohsiungSnapshot from '../data/kaohsiung-flights.json';
import khhPeach from '../data/kaohsiung-peach-flights.json';
import khhJetstar from '../data/kaohsiung-jetstar-flights.json';
import khhJeju from '../data/kaohsiung-jeju-flights.json';
import khhEva from '../data/kaohsiung-eva-flights.json';
import khhVietnam from '../data/kaohsiung-vietnam-flights.json';
import lionSnapshot from '../data/thai-lion-flights.json';
import khhLion from '../data/kaohsiung-thai-lion-flights.json';
import khhExpanded from '../data/kaohsiung-expanded-flights.json';
import ciTpeSnapshot from '../data/ci-tpe-flights.json';
import type { DepartureCode } from '@/features/flights/departure-airports';
import { enrichPeachFlight } from '../providers/peach-enrichment';
import { applyTimetableVerifications } from './timetable-verification';
import {
  collectedDataset,
  mergeCollectedFlights,
  type CollectedSnapshot,
} from '../providers/collected';
const caches = {
  realtime: createCache<Record<string, string>[]>(60_000, 15 * 60_000),
  schedule: createCache<Record<string, string>[]>(30 * 60_000, 24 * 3600_000),
};
async function download(kind: keyof typeof SOURCE_URLS) {
  const response = await fetch(SOURCE_URLS[kind], {
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const content = await response.text();
  if (content.length > 10_000_000) throw new Error('資料大小超過限制');
  const rows = parseCsv(content);
  // Validate schema before replacing last good cache.
  if (kind === 'realtime') {
    if (!normalizeRealtime(rows, taipeiDate()).length)
      throw new Error('沒有可驗證的客運航班');
  } else normalizeSchedule(rows, []);
  return rows;
}
export async function getFlightDataset(
  origin: DepartureCode = 'TPE',
): Promise<FlightDataset> {
  const today = taipeiDate();
  if (origin === 'KHH') {
    const saved = [
      kaohsiungSnapshot,
      khhPeach,
      khhJetstar,
      khhJeju,
      khhEva,
      khhVietnam,
      khhLion,
      khhExpanded,
    ].map((snapshot) => collectedDataset(snapshot as CollectedSnapshot, today));
    const flights = await applyTimetableVerifications(
      saved.flatMap((s) => s.flights),
    );
    return {
      origin,
      today,
      mode: 'official',
      flights,
      feeds: saved.flatMap((s) => s.feeds),
      dates: [...new Set(flights.map((f) => f.date))].sort(),
      warnings: [
        '高雄出發收錄航空公司與機場公布的部分預定班表；並非全部航空公司或即時航班，查不到不代表沒有航班。',
      ],
    };
  }
  if (process.env.FLIGHT_DATA_MODE === 'demo') {
    const flights = demoFlights(today).filter(isActiveAirline);
    const dates = [...new Set(flights.map((f) => f.date))].sort();
    return {
      today,
      flights,
      dates,
      mode: 'demo',
      warnings: ['示範模式：航班與狀態皆為虛構，不能作為旅行依據。'],
      feeds: [
        {
          kind: 'demo',
          label: '虛構示範資料',
          url: SOURCE_PAGES.realtime,
          state: 'ready',
          fetchedAt: null,
          sourceUpdatedAt: null,
          dates,
          warning: null,
        },
      ],
    };
  }
  const results = await Promise.allSettled([
    caches.realtime.get(() => download('realtime')),
    caches.schedule.get(() => download('schedule')),
  ]);
  const feeds: FeedInfo[] = [];
  const warnings = [
    '來源未提供每筆資料的更新時間；下方時間表示本服務取得資料的時間。',
    '桃園機場開放資料未提供可靠的共用班號關係；各來源仍按班號列出，可能包含同一實際航班。',
  ];
  let realtime: Flight[] = [];
  let schedule: Flight[] = [];
  for (const [i, kind] of (['realtime', 'schedule'] as const).entries()) {
    const result = results[i];
    const label =
      kind === 'realtime'
        ? `桃園機場即時航班（${activeAirlineNames}）`
        : `桃園機場定期班表（${activeAirlineNames}）`;
    if (result.status === 'rejected') {
      console.error(
        `[flights:${kind}]`,
        result.reason instanceof Error ? result.reason.message : '資料讀取失敗',
      );
      feeds.push({
        kind,
        label,
        url: SOURCE_PAGES[kind],
        state: 'unavailable',
        fetchedAt: null,
        sourceUpdatedAt: null,
        dates: [],
        warning: `${label}暫時無法取得。`,
      });
      warnings.push(`${label}暫時無法取得，不能確認完整航班資訊。`);
      continue;
    }
    const { value, fetchedAt, stale } = result.value;
    const normalized =
      kind === 'realtime'
        ? normalizeRealtime(value, today)
        : normalizeSchedule(value, realtime);
    const published = normalized.filter(isActiveAirline);
    const relevant = published.filter((f) => f.date >= today);
    const dates = [...new Set(relevant.map((f) => f.date))].sort();
    const warning = !dates.length
      ? `${label}尚無可使用的今日或未來客運資料。`
      : stale
        ? `${label}更新失敗，正在顯示先前取得的資料。`
        : null;
    feeds.push({
      kind,
      label,
      url: SOURCE_PAGES[kind],
      state: stale || !dates.length ? 'stale' : 'ready',
      fetchedAt,
      sourceUpdatedAt: null,
      dates,
      warning,
    });
    if (warning) warnings.push(warning);
    if (kind === 'realtime') realtime = published;
    else {
      schedule = relevant;
      if (dates.length)
        warnings.push('定期班表僅納入可由客運資料辨識的班號，可能不完整。');
    }
  }
  const merged = new Map(schedule.map((f) => [f.id, f]));
  for (const flight of realtime)
    if (flight.date >= today) merged.set(flight.id, flight);
  const eva = collectedDataset(evaSnapshot as CollectedSnapshot, today);
  const peach = collectedDataset(peachSnapshot as CollectedSnapshot, today);
  const tigerair = collectedDataset(
    tigerairSnapshot as CollectedSnapshot,
    today,
  );
  const starlux = collectedDataset(starluxSnapshot as CollectedSnapshot, today);
  const jeju = collectedDataset(jejuSnapshot as CollectedSnapshot, today);
  const vietnam = collectedDataset(vietnamSnapshot as CollectedSnapshot, today);
  const jta = collectedDataset(jtaSnapshot as CollectedSnapshot, today);
  const jetstar = collectedDataset(jetstarSnapshot as CollectedSnapshot, today);
  const philippine = collectedDataset(
    philippineSnapshot as CollectedSnapshot,
    today,
  );
  const lion = collectedDataset(lionSnapshot as CollectedSnapshot, today);
  const ciTpe = collectedDataset(ciTpeSnapshot as CollectedSnapshot, today);
  feeds.push(
    ...ciTpe.feeds,
    ...lion.feeds,
    ...eva.feeds,
    ...peach.feeds,
    ...tigerair.feeds,
    ...starlux.feeds,
    ...jeju.feeds,
    ...vietnam.feeds,
    ...jta.feeds,
    ...jetstar.feeds,
    ...philippine.feeds,
  );
  warnings.push(
    `目前提供${activeAirlineNames}航班；已收集班表仍可能不完整，查不到不代表沒有航班。`,
  );
  const flights = await applyTimetableVerifications(
    mergeCollectedFlights(
      [...merged.values()],
      [
        ...ciTpe.flights,
        ...lion.flights,
        ...eva.flights,
        ...peach.flights,
        ...tigerair.flights,
        ...starlux.flights,
        ...jeju.flights,
        ...vietnam.flights,
        ...jta.flights,
        ...jetstar.flights,
        ...philippine.flights,
      ].filter(isActiveAirline),
    ).map((flight) => enrichPeachFlight(flight)),
  );
  const dates = [...new Set(flights.map((f) => f.date))].sort();
  return { origin, today, flights, feeds, dates, warnings, mode: 'official' };
}
