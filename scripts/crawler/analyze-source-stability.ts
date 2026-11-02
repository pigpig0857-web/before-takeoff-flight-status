/** Compare saved live receipts and browser evidence. No new requests or import. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { taipeiDate } from '../../src/lib/time';
import {
  analyzeTripSample,
  tripCardKey,
  type TripSample,
  type TripDetail,
} from '../../src/server/providers/experimental/trip-direct';
const root = path.resolve('data/source-samples/crawler');
async function json(file: string) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
const keyNumber = (number: string) =>
  number.replace(/^([A-Z0-9]{2})0+(?=\d)/, '$1');
async function main() {
  const index = process.argv.indexOf('--sample-dir');
  if (index >= 0 && !process.argv[index + 1])
    throw new Error('Missing --sample-dir');
  const directory = path.resolve(
    index >= 0
      ? process.argv[index + 1]
      : path.join(root, `stability-${taipeiDate()}`),
  );
  if (
    path.relative(root, directory).startsWith('..') ||
    path.isAbsolute(path.relative(root, directory))
  )
    throw new Error('Evidence directory must stay within crawler samples');
  const snapshot = await json(
    path.resolve('src/server/data/collected-flights.json'),
  );
  const ci = await json(path.resolve('data/cache/ci-network/flights.json'));
  const previous = new Map(
    snapshot.records
      .filter((r: { kind: string }) => r.kind === 'collected_ci')
      .map(
        (r: { number: string; date: string; destinationEnglish: string }) => [
          `${r.number}|${r.date}|${r.destinationEnglish}`,
          r,
        ],
      ),
  );
  const unmatched = ci.records.filter(
    (r: { number: string; departureLocal: string; destinationLabel: string }) =>
      !previous.has(
        `${r.number}|${r.departureLocal.slice(0, 10)}|${r.destinationLabel}`,
      ),
  );
  const changed = ci.records.filter((r: Record<string, unknown>) => {
    const old = previous.get(
      `${r.number}|${String(r.departureLocal).slice(0, 10)}|${r.destinationLabel}`,
    ) as Record<string, unknown> | undefined;
    return (
      old &&
      JSON.stringify([
        old.departure,
        old.arrival,
        old.minutes,
        old.airport,
        old.candidateAirport,
        old.operatingNumber,
      ]) !==
        JSON.stringify([
          r.departureLocal,
          r.arrivalLocal,
          r.durationMinutes,
          r.arrivalAirport,
          r.candidateArrivalAirport,
          r.operatingNumber,
        ])
    );
  });
  const before = analyzeTripSample(
    (await json(path.join(root, 'trip-sydney/cards.json'))) as TripSample,
    (await json(path.join(root, 'trip-sydney/details.json'))) as TripDetail[],
  );
  const current = analyzeTripSample(
    (await json(
      path.join(directory, 'sydney-recheck-cards.json'),
    )) as TripSample,
    (await json(
      path.join(directory, 'sydney-recheck-details.json'),
    )) as TripDetail[],
  );
  const identity = (r: (typeof current.records)[number]) =>
    JSON.stringify([
      r.number,
      r.marketingAirline,
      r.operatingAirline,
      r.departureLocal,
      r.arrivalLocal,
      r.departureTerminal,
      r.arrivalTerminal,
      r.durationMinutes,
      r.aircraftCode,
    ]);
  const stable =
    JSON.stringify(before.records.map(identity).sort()) ===
    JSON.stringify(current.records.map(identity).sort());
  const newDirectory = path.join(root, 'trip-sydney-january-sixteen');
  const newSample = (await json(
    path.join(newDirectory, 'cards.json'),
  )) as TripSample;
  const newFollowup = (await json(
    path.join(newDirectory, 'refreshed-cards.json'),
  )) as TripSample & { followUpKind?: string };
  const newResult = analyzeTripSample(
    newSample,
    (await json(path.join(newDirectory, 'details.json'))) as TripDetail[],
  );
  const cardsAgree =
    JSON.stringify(newSample.rows.map(tripCardKey).sort()) ===
    JSON.stringify(newFollowup.rows.map(tripCardKey).sort());
  if (
    !before.completeObservedResult ||
    !current.completeObservedResult ||
    !newResult.completeObservedResult ||
    !cardsAgree ||
    newFollowup.displayedDirectCount !== newSample.displayedDirectCount
  )
    throw new Error('Incomplete Trip observations');
  const eva = await json(path.join(root, 'eva-narita-trial/analysis.json'));
  const ciChecks = await json(path.join(root, 'ci-stability/latest.json'));
  const probe = (await json(path.join(root, 'trip/latest-trial.json')))
    .htmlProbe;
  const seen = new Set(
    snapshot.records.map(
      (r: {
        number: string;
        date: string;
        airport: string | null;
        departure: string;
      }) => `${keyNumber(r.number)}|${r.date}|${r.airport}|${r.departure}`,
    ),
  );
  const newCandidates = [...eva.records, ...newResult.records];
  const candidateKey = (r: {
    number: string;
    departureLocal: string;
    arrival: string;
  }) =>
    `${keyNumber(r.number)}|${r.departureLocal.slice(0, 10)}|${r.arrival}|${r.departureLocal}`;
  const additional = new Set(
    newCandidates.map(candidateKey).filter((k) => !seen.has(k)),
  );
  const report = {
    analyzedAt: new Date().toISOString(),
    evidenceDirectory: directory,
    ci: {
      currentRecords: ci.records.length,
      matchedExistingRecords: ci.records.length - unmatched.length,
      changedExistingRecords: changed.length,
      newIdentities: unmatched.length,
      sourceValidUntil: ci.coverage.sourceValidUntil,
      liveReceipt: ci.coverage.sourceRetrievedAt,
      todayLiveDownloads: ciChecks.runs.length + 1,
      receiptNote:
        'Includes the same-day baseline live receipt plus this bounded runner; not long-term success rate',
      failureProbe: ciChecks.failureProbe,
    },
    trip: {
      crossDayVerifiedDetails: current.records.length,
      crossDayScheduleMatches: stable,
      newDate: newSample.query.date,
      newDateVerifiedDetails: newResult.records.length,
      afterReloadFilterRepairMatches: cardsAgree,
      followUpKind: newFollowup.followUpKind,
      normalHttpProbe: probe,
      unattendedCollectorEstablished: false,
    },
    eva: {
      verifiedDetails: eva.verifiedDetails,
      sameWeekAfterFollowup: eva.sameWeekAfterFollowup,
      normalHttpProbe: await json(
        path.join(root, 'eva-narita-trial/http-probe.json'),
      ),
      earliestDate: eva.records
        .map((r: { departureLocal: string }) => r.departureLocal.slice(0, 10))
        .sort()[0],
      lastDate: eva.records
        .map((r: { departureLocal: string }) => r.departureLocal.slice(0, 10))
        .sort()
        .at(-1),
      officialVsTripComparisons: eva.comparisons,
      unattendedCollectorEstablished: false,
    },
    newResearch: {
      rawValidatedRecords: newCandidates.length,
      additionalMarketingIdentities: additional.size,
      overlapExistingWebsiteRecords: newCandidates.length - additional.size,
      appliedToWebsite: false,
    },
    websiteSnapshotRecords: snapshot.records.length,
    allTaoyuanFlightsCollected: false,
  };
  await fs.writeFile(
    path.join(directory, 'analysis.json'),
    JSON.stringify(report, null, 2),
  );
  await fs.writeFile(
    path.join(directory, 'http-probe.json'),
    JSON.stringify(probe, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
