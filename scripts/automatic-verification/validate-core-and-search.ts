// Offline validation of the saved catalogue and the website's actual filtering
// and card components. This does not refresh official source verification.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { taipeiDate } from '../../src/lib/time';
import {
  normalizeCollected,
  type SavedFlight,
} from '../../src/server/providers/collected';
import {
  enrichTimetableVerification,
  verificationKey,
  type VerificationLedger,
} from '../../src/server/services/timetable-verification';
import {
  arrivalAirport,
  destinationCountry,
} from '../../src/features/flights/destinations';
import { filterFlights, parseFilters } from '../../src/features/flights/filter';
import {
  airportTimeZone,
  zonedParts,
  durationLabel,
  calendarDayLabel,
} from '../../src/features/flights/journey-time';
import { FlightCard } from '../../src/features/flights/flight-card';
import { FlightDetails } from '../../src/features/flights/flight-details';
import { timetableReviewNotice } from '../../src/features/flights/verification';
import type { Flight } from '../../src/features/flights/types';
import { sha } from './sources';

const brands = [
  'eva',
  'peach',
  'tigerair',
  'starlux',
  'jeju',
  'vietnam',
  'jta',
  'jetstar',
];
const from = taipeiDate(),
  through = '2026-12-31';
const read = async (file: string) =>
  JSON.parse(await fs.readFile(file, 'utf8'));
async function main() {
  assert.ok(from <= through, 'Scope expired; no validation launched');
  const base = path.resolve('data/automatic-verification');
  const root = path.join(base, 'validation', `${from}-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  const job = await read(path.join(base, 'runs', from, 'progress.json'));
  const ledger = (await read(
    path.join(base, 'latest.json'),
  )) as VerificationLedger;
  const protectedFiles = [
    ...Object.keys(job.originals),
    path.join(base, 'latest.json'),
    path.join(base, 'runs', from, 'progress.json'),
    path.join(base, 'source-stops', from + '.json'),
  ];
  const before = Object.fromEntries(
    await Promise.all(
      protectedFiles.map(async (file) => [file, sha(await fs.readFile(file))]),
    ),
  );
  for (const [file, digest] of Object.entries(job.originals))
    assert.equal(before[file], digest);
  const progress: any = {
    startedAt: new Date().toISOString(),
    scope: { from, through, origin: 'TPE' },
    state: 'running',
    officialSourceRequests: 0,
    verifiedAtUpdates: 0,
    meaning:
      'Internal consistency of already saved rows; not proof of complete airline coverage or source recovery',
    byAirline: [],
    problems: [],
    dateSearches: 0,
    countrySearches: 0,
    airportSearches: 0,
    protectedHashes: before,
  };
  const resumeIndex = process.argv.indexOf('--reuse-core');
  const previous =
    resumeIndex < 0 ? undefined : await read(process.argv[resumeIndex + 1]);
  if (previous) {
    assert.deepEqual(previous.scope, progress.scope);
    assert.equal(previous.problems.length, 0);
    // Earlier checkpoints predate the hashes field; the existing repair proof
    // pins the ledger/stops, while daily originals pin all eleven catalogues.
    const pins =
      previous.protectedHashes ||
      (await read(path.join(base, 'runtime/2026-10-15-repair-diagnostic.json')))
        .protectedHashes;
    for (const [file, expected] of Object.entries(pins))
      assert.equal(sha(await fs.readFile(file)), expected);
    progress.reusedCoreReport = process.argv[resumeIndex + 1];
  }
  const checkpoint = async () => {
    const file = path.join(root, 'progress.json'),
      temporary = file + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(progress, null, 2) + '\n');
    await fs.rename(temporary, file);
  };
  await checkpoint();
  const all: Flight[] = [],
    identities = new Set<string>();
  for (const brand of brands) {
    const saved = (
      await read(`src/server/data/${brand}-flights.json`)
    ).records.filter(
      (r: SavedFlight) => r.date >= from && r.date <= through,
    ) as SavedFlight[];
    const summary = {
      brand,
      records: saved.length,
      corePassed: 0,
      cardsPassed: 0,
      priorDayArrivals: 0,
      nextDayArrivals: 0,
    };
    const prior = previous?.byAirline.find((a: any) => a.brand === brand);
    if (previous) {
      assert.equal(prior?.records, saved.length);
      assert.equal(prior?.corePassed, saved.length);
      assert.equal(prior?.cardsPassed, saved.length);
    }
    for (const row of saved) {
      const key = verificationKey(row);
      try {
        assert.ok(!identities.has(key), `Duplicate ${key}`);
        identities.add(key);
        const flight = enrichTimetableVerification(
          normalizeCollected(row),
          ledger,
        );
        const airport = arrivalAirport(flight.destinationCode);
        assert.ok(
          airport && row.countryCode && destinationCountry(row.countryCode),
          'Missing destination/country',
        );
        assert.equal(airport.countryCode, row.countryCode);
        const zone = airportTimeZone(flight.destinationCode);
        assert.ok(
          zone && flight.scheduledArrival && flight.arrivalTimeZone,
          'Missing arrival/timezone',
        );
        const arrival = zonedParts(flight.scheduledArrival, zone);
        assert.deepEqual(
          arrival,
          zonedParts(flight.scheduledArrival, flight.arrivalTimeZone),
        );
        assert.deepEqual(zonedParts(flight.scheduledDeparture, 'Asia/Taipei'), {
          date: row.date,
          time: row.departure.slice(11, 16),
        });
        assert.equal(
          (Date.parse(flight.scheduledArrival) -
            Date.parse(flight.scheduledDeparture)) /
            60000,
          row.minutes,
        );
        assert.equal(flight.durationMinutes, row.minutes);
        assert.ok(
          new URL(row.url).protocol === 'https:' && row.fetchedAt,
          'Missing HTTPS source/time',
        );
        assert.ok(
          flight.timetableVerification,
          'Saved verification fingerprint did not attach',
        );
        summary.corePassed++;
        if (!prior) {
          const card = renderToStaticMarkup(
            createElement(FlightCard, { flight, onSelect: () => {} }),
          );
          const details = renderToStaticMarkup(
            createElement(FlightDetails, {
              flight,
              stale: false,
              onClose: () => {},
            }),
          );
          for (const html of [card, details]) {
            assert.ok(
              html.includes(flight.number) &&
                html.includes(flight.destinationCode),
            );
            assert.ok(
              html.includes(row.departure.slice(11, 16)) &&
                html.includes(arrival.time),
            );
            assert.ok(html.includes(calendarDayLabel(arrival.date, row.date)));
            const review = timetableReviewNotice(flight);
            if (review)
              assert.ok(
                html.includes(review.label),
                'Pending warning is missing',
              );
          }
          assert.ok(
            details.includes(`起飛至抵達 ${durationLabel(row.minutes)}`),
          );
        }
        summary.cardsPassed++;
        if (arrival.date < row.date) summary.priorDayArrivals++;
        if (arrival.date > row.date) summary.nextDayArrivals++;
        all.push(flight);
      } catch (e) {
        progress.problems.push({ key, brand, reason: (e as Error).message });
      }
    }
    progress.byAirline.push(summary);
    await checkpoint();
    console.log(JSON.stringify(summary));
  }
  const ids = (flights: Flight[]) => flights.map((f) => f.id).sort();
  for (
    let day = Date.parse(from + 'T00:00:00Z');
    day <= Date.parse(through + 'T00:00:00Z');
    day += 86400_000
  ) {
    const date = new Date(day).toISOString().slice(0, 10);
    const rows = all.filter((f) => f.date === date);
    const query = (q: string) =>
      filterFlights(all, parseFilters(new URLSearchParams({ date, q }), from));
    try {
      const result = query('');
      assert.deepEqual(ids(result), ids(rows));
      assert.deepEqual(
        result.map((f) => f.scheduledDeparture),
        rows.map((f) => f.scheduledDeparture).sort(),
      );
      progress.dateSearches++;
      for (const country of new Set(
        rows.map((f) => f.collected!.countryCode!),
      )) {
        const name =
          country === 'HK'
            ? '香港'
            : country === 'MO'
              ? '澳門'
              : destinationCountry(country)!.name;
        assert.deepEqual(
          ids(query(name)),
          ids(rows.filter((f) => f.collected!.countryCode === country)),
          `Country ${country}`,
        );
        progress.countrySearches++;
      }
      for (const code of new Set(rows.map((f) => f.destinationCode))) {
        assert.deepEqual(
          ids(query(code)),
          ids(rows.filter((f) => f.destinationCode === code)),
          `Airport ${code}`,
        );
        progress.airportSearches++;
      }
    } catch (e) {
      progress.problems.push({ date, reason: (e as Error).message });
    }
    if (progress.dateSearches % 10 === 0) await checkpoint();
  }
  for (const [file, digest] of Object.entries(before))
    assert.equal(
      sha(await fs.readFile(file)),
      digest,
      `Protected file changed: ${file}`,
    );
  progress.protectedFilesUnchanged = protectedFiles.length;
  progress.records = progress.byAirline.reduce(
    (n: number, a: any) => n + a.records,
    0,
  );
  progress.finishedAt = new Date().toISOString();
  progress.state = progress.problems.length
    ? 'needs_review'
    : 'saved_core_and_search_passed';
  progress.liveSourceVerification = {
    state: job.state,
    verified: job.summary.verifiedRows,
    pending: job.summary.pendingRows,
    repeatedToday: false,
  };
  await checkpoint();
  console.log(
    JSON.stringify({
      report: path.relative(process.cwd(), path.join(root, 'progress.json')),
      state: progress.state,
      records: progress.records,
      problems: progress.problems.length,
      dateSearches: progress.dateSearches,
      countrySearches: progress.countrySearches,
      airportSearches: progress.airportSearches,
      protectedFilesUnchanged: progress.protectedFilesUnchanged,
    }),
  );
  if (progress.problems.length) process.exitCode = 1;
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
