/** Replay saved DOM observations, without contacting Trip.com. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import {
  analyzeTripSample,
  tripCardKey,
  type TripCard,
  type TripDetail,
} from '../../src/server/providers/experimental/trip-direct';

const sampleRoot = resolve('data/source-samples/crawler');
const flagIndex = process.argv.indexOf('--sample-dir');
if (flagIndex >= 0 && !process.argv[flagIndex + 1])
  throw new Error('Missing --sample-dir value');
const directory =
  flagIndex >= 0
    ? resolve(process.argv[flagIndex + 1])
    : resolve(sampleRoot, 'trip-direct-expansion');
const samplePath = relative(sampleRoot, directory);
if (samplePath.startsWith('..') || isAbsolute(samplePath))
  throw new Error('Samples must stay in data/source-samples/crawler');
type Sample = {
  capturedAt: string;
  displayedDirectCount: number;
  rows: TripCard[];
  followUpKind?: string;
  query: {
    departure: string;
    arrival: string;
    date: string;
    directOnly: boolean;
  };
};
async function json<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(directory, name), 'utf8')) as T;
}
async function main() {
  const original = await json<Sample>('cards.json');
  const refreshed = await json<Sample>('refreshed-cards.json');
  const details = await json<TripDetail[]>('details.json');
  const sameCardsAfterRefresh =
    JSON.stringify(original.rows.map(tripCardKey).sort()) ===
    JSON.stringify(refreshed.rows.map(tripCardKey).sort());
  if (!sameCardsAfterRefresh)
    throw new Error(
      'Result identities changed: recollect details instead of combining different searches',
    );
  const analysis = {
    analyzedAt: new Date().toISOString(),
    query: original.query,
    originalListObservedAt: original.capturedAt,
    refreshedListObservedAt: refreshed.capturedAt,
    followUpKind: refreshed.followUpKind ?? 'reload',
    sameCardsAfterFollowup: sameCardsAfterRefresh,
    sameCardsAfterRefresh: refreshed.followUpKind
      ? null
      : sameCardsAfterRefresh,
    ...analyzeTripSample(
      {
        ...original,
        rows: refreshed.rows,
        displayedDirectCount: refreshed.displayedDirectCount,
      },
      details,
    ),
  };
  if (
    !original.query ||
    !original.query.directOnly ||
    analysis.records.some(
      (r) =>
        r.departure !== original.query.departure ||
        r.arrival !== original.query.arrival ||
        !r.departureLocal.startsWith(original.query.date + 'T'),
    )
  )
    throw new Error('Query metadata does not match observed flight records');
  await writeFile(
    resolve(directory, 'analysis.json'),
    JSON.stringify(analysis, null, 2),
  );
  const columns = [
    'number',
    'marketingAirline',
    'operatingAirline',
    'codeshareExplicitlyShown',
    'departure',
    'arrival',
    'departureLocal',
    'arrivalLocal',
    'departureTerminal',
    'arrivalTerminal',
    'durationMinutes',
    'aircraftCode',
    'observedAt',
    'sourceUrl',
  ] as const;
  const escape = (value: unknown) =>
    `"${String(value ?? '').replace(/"/g, '""')}"`;
  await writeFile(
    resolve(directory, 'flights.csv'),
    '\ufeff' +
      [
        columns.join(','),
        ...analysis.records.map((record) =>
          columns.map((column) => escape(record[column])).join(','),
        ),
      ].join('\r\n'),
  );
  console.log(
    JSON.stringify(
      {
        completeObservedResult: analysis.completeObservedResult,
        capturedCards: analysis.capturedCards,
        validatedDetails: analysis.validatedDetails,
        codeshares: analysis.codeshares,
        marketingAirlines: analysis.marketingAirlines,
        flightNumbers: analysis.records.map((r) => r.number),
        outputDirectory: directory,
      },
      null,
      2,
    ),
  );
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
