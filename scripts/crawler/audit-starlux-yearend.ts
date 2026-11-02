import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  parseStarluxWeek,
  starluxDay,
  type StarluxResponse,
  type StarluxResearchFlight,
} from '../../src/server/providers/experimental/starlux-timetable';

async function main() {
  const root = path.resolve(
    'data/source-samples/crawler/additional-airlines-20261013',
  );
  const store = path.join(root, 'starlux-centered'),
    output = path.join(root, 'verified-starlux');
  const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const load = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
  const plan = (await load(path.join(store, 'plan.json'))) as {
    from: string;
    through: string;
    destinations: string[];
    requests: { week: string; date: string; destination: string }[];
    protectedHashes: Record<string, string>;
    scopeHash: string;
  };
  const progress = await load(path.join(store, 'progress.json'));
  if (
    progress.state !== 'raw_collection_complete' ||
    progress.completed !== plan.requests.length
  )
    throw new Error('Collection unfinished; preserve progress and wait');
  await mkdir(output, { recursive: true });
  const save = (name: string, value: unknown) =>
    writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx',
    });
  const pending: unknown[] = [],
    conflicts: unknown[] = [],
    excluded: unknown[] = [],
    queryChecks: unknown[] = [];
  type SavedFlight = StarluxResearchFlight & {
    source: {
      file: string;
      sha256: string;
      retrievedAt: string;
      sourceUrl: string;
    };
  };
  const flights = new Map<string, SavedFlight>();
  const observedCells = new Set<string>();
  let sourceRows = 0;
  for (const cell of plan.requests) {
    const key = `${cell.destination}-${cell.week}`;
    const bytes = await readFile(path.join(store, `${key}.json`));
    const receipt = await load(path.join(store, `${key}.receipt.json`));
    if (
      receipt.status !== 200 ||
      receipt.sha256 !== hash(bytes) ||
      receipt.bytes !== bytes.length
    )
      throw new Error(`Invalid evidence ${key}`);
    const response = JSON.parse(bytes.toString('utf8')) as StarluxResponse;
    const result = parseStarluxWeek(response, {
      destination: cell.destination,
      date: cell.date,
      from: plan.from,
      through: plan.through,
    });
    sourceRows += response.data.timetable.length;
    pending.push(...result.pending.map((r) => ({ query: key, ...r })));
    conflicts.push(...result.conflicts.map((r) => ({ query: key, ...r })));
    excluded.push(...result.excluded.map((r) => ({ query: key, ...r })));
    queryChecks.push({
      key,
      status: 200,
      sourceRows: response.data.timetable.length,
      flights: result.flights.length,
      pending: result.pending.length,
      conflicts: result.conflicts.length,
      from: result.start,
      through: result.end,
      sha256: receipt.sha256,
    });
    if (!result.pending.length && !result.conflicts.length) {
      for (
        let date = result.start;
        date <= result.end;
        date = starluxDay(date, 1)
      )
        if (date >= plan.from && date <= plan.through)
          observedCells.add(`${date}|${cell.destination}`);
    }
    for (const f of result.flights) {
      const saved = {
        ...f,
        source: {
          file: `../starlux-centered/${key}.json`,
          sha256: receipt.sha256,
          retrievedAt: receipt.fetchedAt,
          sourceUrl: receipt.url,
        },
      };
      if (flights.has(f.id)) {
        conflicts.push({
          query: key,
          id: f.id,
          observations: [flights.get(f.id), saved],
        });
        flights.delete(f.id);
      } else flights.set(f.id, saved);
    }
  }
  const sorted = [...flights.values()].sort(
    (a, b) =>
      a.scheduledDeparture.localeCompare(b.scheduledDeparture) ||
      a.id.localeCompare(b.id),
  );
  for (const month of ['2026-10', '2026-11', '2026-12']) {
    const batch = sorted.filter((f) => f.date.startsWith(month));
    await save(`flights-${month}.json`, {
      researchOnly: true,
      airline: 'JX',
      from: plan.from,
      through: plan.through,
      kind: 'published_official_timetable',
      realtimeVerified: false,
      bookingInventoryVerified: false,
      flights: batch,
    });
    await save(`checkpoint-${month}.json`, {
      savedAt: new Date().toISOString(),
      count: batch.length,
      month,
      importedIntoWebsite: false,
    });
  }
  const count = (values: string[]) =>
    Object.fromEntries(
      [...new Set(values)]
        .sort()
        .map((k) => [k, values.filter((v) => v === k).length]),
    );
  const requiredCells: string[] = [];
  for (let date = plan.from; date <= plan.through; date = starluxDay(date, 1))
    for (const d of plan.destinations) requiredCells.push(`${date}|${d}`);
  const missingCells = requiredCells.filter((k) => !observedCells.has(k));
  const afterHashes = Object.fromEntries(
    await Promise.all(
      Object.keys(plan.protectedHashes).map(async (n) => [
        n,
        hash(await readFile(path.resolve('src/server/data', n))),
      ]),
    ),
  );
  const scopeHash = hash(
    await readFile('src/features/flights/airline-scope.ts'),
  );
  const websiteUnchanged =
    JSON.stringify(afterHashes) === JSON.stringify(plan.protectedHashes) &&
    scopeHash === plan.scopeHash;
  const audit = {
    state:
      pending.length || conflicts.length || missingCells.length
        ? 'pending_review'
        : 'verified_published_timetable',
    verifiedAt: new Date().toISOString(),
    from: plan.from,
    through: plan.through,
    airline: 'JX',
    origin: 'TPE',
    sourceUrl: 'https://www.starlux-airlines.com/zh-TW/timetable',
    queries: queryChecks.length,
    plannedQueries: plan.requests.length,
    sourceRows,
    flights: sorted.length,
    destinations: plan.destinations.length,
    byDestination: count(sorted.map((f) => f.destination)),
    byCountry: count(sorted.map((f) => f.countryCode)),
    byMonth: count(sorted.map((f) => f.date.slice(0, 7))),
    coverage: {
      observed: observedCells.size,
      expected: requiredCells.length,
      missingCells,
    },
    pendingRows: pending.length,
    conflictingIdentities: conflicts.length,
    excluded,
    fields: {
      aircraft: sorted.filter((f) => f.aircraft).length,
      departureTerminal: sorted.filter((f) => f.departureTerminal).length,
      arrivalTerminal: sorted.filter((f) => f.arrivalTerminal).length,
      approvalPending: sorted.filter((f) => f.approvalPending).length,
      gate: 0,
      counter: 0,
    },
    websiteUnchanged,
    protectedHashes: plan.protectedHashes,
    afterHashes,
    scopeHash,
    importedIntoWebsite: false,
  };
  await save('pending.json', { pending, conflicts });
  await save('query-checks.json', queryChecks);
  await save('audit.json', audit);
  console.log(
    JSON.stringify(
      {
        ...audit,
        protectedHashes: undefined,
        afterHashes: undefined,
        excluded: excluded.length,
      },
      null,
      2,
    ),
  );
  if (
    !websiteUnchanged ||
    pending.length ||
    conflicts.length ||
    missingCells.length
  )
    process.exitCode = 1;
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
