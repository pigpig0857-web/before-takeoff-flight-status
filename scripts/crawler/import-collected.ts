/** Validate saved evidence, then build a deployable server-only snapshot. No network. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  parseCiNetwork,
  ciNetworkFlightsOnDate,
} from '../../src/server/providers/experimental/ci-network';
import {
  analyzeTripSample,
  type TripSample,
  type TripDetail,
} from '../../src/server/providers/experimental/trip-direct';
import {
  normalizeCollected,
  type SavedFlight,
  type CollectedSnapshot,
} from '../../src/server/providers/collected';
import { arrivalAirport } from '../../src/features/flights/destinations';

const root = path.resolve('data/source-samples/crawler');
const airlineNames: Record<string, string> = {
  CI: '中華航空',
  AE: '華信航空',
  JL: '日本航空',
  KE: '大韓航空',
  MH: '馬來西亞航空',
  VN: '越南航空',
  PR: '菲律賓航空',
  BI: '汶萊皇家航空',
  MU: '中國東方航空',
  CZ: '中國南方航空',
  MF: '廈門航空',
  KL: '荷蘭皇家航空',
};
async function json(file: string) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function main() {
  const ci = await json(path.resolve('data/cache/ci-network/coverage.json'));
  if (
    !ci.allPublishedDatesValidated ||
    !ci.sourceRetrievedAt ||
    !ci.actualFrom ||
    ci.allTaoyuanFutureFlightsComplete !== false
  )
    throw new Error('CI evidence incomplete');
  const timetable = parseCiNetwork(
    await json(path.join(root, 'ci-network-extraction.json')),
  );
  if (timetable.validUntil !== ci.sourceValidUntil)
    throw new Error('CI validity mismatch');
  const records: SavedFlight[] = [];
  for (
    let date = ci.actualFrom;
    date <= timetable.validUntil;
    date = new Date(Date.parse(date) + 86400_000).toISOString().slice(0, 10)
  ) {
    for (const f of ciNetworkFlightsOnDate(timetable, date)) {
      const candidate = f.candidateArrivalAirport
        ? arrivalAirport(f.candidateArrivalAirport)
        : undefined;
      records.push({
        number: f.number,
        airline: airlineNames[f.marketingCarrier] || f.marketingCarrier,
        date,
        departure: f.departureLocal,
        arrival: f.arrivalLocal,
        arrivalTimeZone: f.arrivalTimeZone,
        airport: f.arrivalAirport,
        candidateAirport: f.candidateArrivalAirport,
        destination:
          candidate?.city ||
          (f.destinationLabel === 'CHENGDU' ? '成都' : f.destinationLabel),
        destinationEnglish: f.destinationLabel,
        countryCode:
          candidate?.countryCode ||
          (f.destinationLabel === 'CHENGDU' ? 'CN' : null),
        terminal: null,
        arrivalTerminal: null,
        aircraft: f.aircraft,
        minutes: f.durationMinutes,
        kind: 'collected_ci',
        label: '華航公開預定班表',
        url: ci.sourceUrl,
        fetchedAt: ci.sourceRetrievedAt,
        operatingAirline: f.operatingCarrier
          ? airlineNames[f.operatingCarrier] || f.operatingCarrier
          : null,
        operatingNumber: f.operatingNumber,
        codeshare: Boolean(f.operatingNumber),
        page: f.sourcePage,
      });
    }
  }
  if (records.length !== ci.dailyMarketingRecords)
    throw new Error('CI record count mismatch');
  const ciDates = [...new Set(records.map((r) => r.date))].sort();
  const tripCoverage = await json(
    path.resolve('data/cache/research-flights/coverage.json'),
  );
  const tripRecords: SavedFlight[] = [];
  for (const c of tripCoverage.cases) {
    if (
      !/^trip-[a-z-]+$/.test(c.sampleDirectory) ||
      c.status !== 'complete_observed_result'
    )
      throw new Error('Unvalidated Trip sample');
    const directory = path.join(root, c.sampleDirectory);
    const sample = (await json(
      path.join(directory, 'cards.json'),
    )) as TripSample;
    const details = (await json(
      path.join(directory, 'details.json'),
    )) as TripDetail[];
    const analyzed = analyzeTripSample(sample, details);
    if (!analyzed.completeObservedResult)
      throw new Error('Incomplete Trip observation');
    for (const f of analyzed.records) {
      const airport = arrivalAirport(f.arrival);
      if (!airport) throw new Error('Unknown Trip airport');
      tripRecords.push({
        number: f.number,
        airline: f.marketingAirline,
        date: f.departureLocal.slice(0, 10),
        departure: f.departureLocal,
        arrival: f.arrivalLocal,
        arrivalTimeZone: f.arrivalTimeZone,
        airport: f.arrival,
        candidateAirport: null,
        destination: airport.city,
        destinationEnglish: airport.name,
        countryCode: airport.countryCode,
        terminal: f.departureTerminal,
        arrivalTerminal: f.arrivalTerminal,
        aircraft: f.aircraftCode,
        minutes: f.durationMinutes,
        kind: 'collected_trip',
        label: 'Trip.com 已收集的直飛班表',
        url: f.sourceUrl,
        fetchedAt: f.observedAt,
        operatingAirline: f.operatingAirline,
        operatingNumber: f.operatingFlightNumber,
        codeshare: f.codeshareExplicitlyShown,
        page: null,
      });
    }
  }
  if (tripRecords.length !== tripCoverage.uniqueMarketingRecords)
    throw new Error('Trip record count mismatch');
  const coverage: CollectedSnapshot['coverage'] = [
    {
      kind: 'collected_ci',
      label: '華航公開預定班表（部分航空公司）',
      url: ci.sourceUrl,
      fetchedAt: ci.sourceRetrievedAt,
      description: `華航出版班表：${ciDates[0]}～${ciDates.at(-1)}，57 個目的地；部分機場須核對。`,
      dates: ciDates,
      records: records.length,
    },
    {
      kind: 'collected_trip',
      label: 'Trip.com 已收集的直飛班表（指定航線／日期）',
      url: 'https://tw.trip.com/flights/',
      fetchedAt: tripRecords.map((r) => r.fetchedAt).sort()[0],
      description:
        '2026/12/30 成田；2027/01/15 仁川、雪梨、舊金山、曼谷 BKK。其他日期與目的地尚未收集。',
      dates: [...new Set(tripRecords.map((r) => r.date))].sort(),
      records: tripRecords.length,
    },
  ];
  records.push(...tripRecords);
  records.forEach(normalizeCollected);
  const identities = new Set(
    records.map((r) =>
      [
        r.kind,
        r.date,
        r.number,
        r.airport || r.destinationEnglish,
        r.departure,
      ].join('|'),
    ),
  );
  if (identities.size !== records.length)
    throw new Error('Duplicate saved identities');
  const snapshot: CollectedSnapshot = {
    version: 1,
    importedAt: new Date().toISOString(),
    records,
    coverage,
  };
  const output = path.resolve('src/server/data/collected-flights.json');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(snapshot) + '\n');
  console.log(
    JSON.stringify(
      {
        records: records.length,
        ci: ci.dailyMarketingRecords,
        trip: tripRecords.length,
        output,
      },
      null,
      2,
    ),
  );
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
