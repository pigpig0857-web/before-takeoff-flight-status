/** Validate saved official browser observations. This does not contact EVA Air. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  analyzeEvaWeek,
  evaTableEntries,
  type EvaWeek,
  type EvaDetail,
} from '../../src/server/providers/experimental/eva-schedule';
const directory = path.resolve('data/source-samples/crawler/eva-narita-trial');
async function json<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'));
}
async function main() {
  const week = await json<EvaWeek>('week-cards.json');
  const nextWeek = await json<EvaWeek>('next-week-cards.json');
  const details = await json<EvaDetail[]>('details.json');
  const firstDates = new Set(
    week.rows.flatMap((r) => r.cells.map((c) => c.dateLabel)),
  );
  const nextDates = new Set(
    nextWeek.rows.flatMap((r) => r.cells.map((c) => c.dateLabel)),
  );
  if (
    details.some(
      (d) => !firstDates.has(d.dateLabel) && !nextDates.has(d.dateLabel),
    )
  )
    throw new Error('Unlisted EVA detail date');
  const firstResult = analyzeEvaWeek(
    week,
    details.filter((d) => firstDates.has(d.dateLabel)),
  );
  const nextResult = analyzeEvaWeek(
    nextWeek,
    details.filter((d) => nextDates.has(d.dateLabel)),
  );
  const result = {
    observedEntries: firstResult.observedEntries + nextResult.observedEntries,
    verifiedDetails: firstResult.verifiedDetails + nextResult.verifiedDetails,
    completeObservedWeek:
      firstResult.completeObservedWeek && nextResult.completeObservedWeek,
    missingDetails: firstResult.missingDetails + nextResult.missingDetails,
    records: [...firstResult.records, ...nextResult.records],
  };
  const repeated = await json<EvaWeek>('rechecked-week.json');
  // Generated detail link tokens can change; compare date/number/route/time instead.
  const identity = (w: EvaWeek) =>
    evaTableEntries(w)
      .map(({ detailLink, ...entry }) => JSON.stringify(entry))
      .sort();
  const sameWeekAfterFollowup =
    JSON.stringify(identity(week)) === JSON.stringify(identity(repeated));
  if (!result.completeObservedWeek || !sameWeekAfterFollowup)
    throw new Error('EVA observation incomplete or schedule changed');
  const trip = JSON.parse(
    await fs.readFile(
      path.resolve(
        'data/source-samples/crawler/trip-direct-expansion/analysis.json',
      ),
      'utf8',
    ),
  );
  const comparisons = result.records
    .filter((r) => r.departureLocal.startsWith('2026-12-30'))
    .map((record) => {
      const matched = trip.records.find(
        (r: { number: string }) => r.number === record.normalizedNumber,
      );
      return {
        number: record.normalizedNumber,
        independentlyObservedOnTrip: Boolean(matched),
        scheduledTimesAgree: matched
          ? matched.departureLocal === record.departureLocal &&
            matched.arrivalLocal === record.arrivalLocal
          : null,
      };
    });
  const report = {
    analyzedAt: new Date().toISOString(),
    scope: 'Two observed EVA TPE–NRT weeks only',
    automaticNetworkCollector: false,
    integratedIntoWebsite: false,
    publishedMaxDaysClaim: 360,
    maxDaysActuallyCollected: false,
    sameWeekAfterFollowup,
    comparisons,
    ...result,
  };
  await fs.writeFile(
    path.join(directory, 'analysis.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        observedEntries: result.observedEntries,
        verifiedDetails: result.verifiedDetails,
        sameWeekAfterFollowup,
        comparisons,
        output: path.join(directory, 'analysis.json'),
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
