import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  addTigerDays,
  expandTigerSnapshot,
  tigerWeekdays,
  type TigerSnapshot,
} from '../../src/server/providers/experimental/tigerair-schedule';

async function main() {
  const root = path.resolve(
    'data/source-samples/crawler/tigerair-research-20261013',
  );
  const enriched = process.argv.includes('--with-timezone-evidence');
  const output = enriched ? path.join(root, 'verified-with-timezones') : root;
  await mkdir(output, { recursive: true });
  const from = '2026-10-13';
  const through = '2026-12-31';
  const hash = (bytes: Buffer) =>
    createHash('sha256').update(bytes).digest('hex');
  const save = async (name: string, value: unknown) =>
    writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx',
    });
  const protectedFiles = [
    'eva-flights.json',
    'peach-flights.json',
    'peach-booking-checks.json',
    'peach-verification-progress.json',
    'collected-flights.json',
  ];
  const beforeHashes = Object.fromEntries(
    await Promise.all(
      protectedFiles.map(async (name) => [
        name,
        hash(await readFile(path.resolve('src/server/data', name))),
      ]),
    ),
  );
  const scopeHash = hash(
    await readFile(path.resolve('src/features/flights/airline-scope.ts')),
  );
  await save('audit-start.json', {
    startedAt: new Date().toISOString(),
    from,
    through,
    researchOnly: true,
    beforeHashes,
    scopeHash,
  });
  const raw = await readFile(path.join(root, 'merged-schedules.json'));
  const receipt = JSON.parse(
    await readFile(path.join(root, 'merged-receipt.json'), 'utf8'),
  );
  if (
    receipt.status !== 200 ||
    receipt.sha256 !== hash(raw) ||
    receipt.bytes !== raw.length
  )
    throw new Error('Source receipt/hash mismatch');
  const snapshot = JSON.parse(raw.toString('utf8')) as TigerSnapshot;
  let verifiedTimeZones: Record<string, string> = {};
  if (enriched) {
    const extra = JSON.parse(
      await readFile(path.join(root, 'additional-timezones.json'), 'utf8'),
    ) as {
      sha256: string;
      airports: { code: string; timeZone: string }[];
    };
    if (
      extra.sha256 !==
      hash(await readFile(path.join(root, 'openflights-airports.dat')))
    )
      throw new Error('Timezone evidence hash mismatch');
    verifiedTimeZones = Object.fromEntries(
      extra.airports.map((a) => [a.code, a.timeZone]),
    );
  }
  const result = expandTigerSnapshot(
    snapshot,
    from,
    through,
    verifiedTimeZones,
  );
  const provenance = {
    pageUrl: 'https://www.tigerairtw.com/zh-TW/ready-to-go/flight-schedule',
    sourceUrl: receipt.url,
    retrievedAt: receipt.fetchedAt,
    rawSha256: receipt.sha256,
    researchOnly: true,
    type: 'published_schedule',
    bookingInventoryVerified: false,
    realtimeStatusVerified: false,
  };

  // Preserve each batch separately; replay reads existing evidence, never repeats HTTP.
  for (const month of ['2026-10', '2026-11', '2026-12']) {
    const flights = result.flights.filter((f) => f.date.startsWith(month));
    await save(`flights-${month}.json`, { provenance, flights });
    await save(`checkpoint-${month}.json`, {
      savedAt: new Date().toISOString(),
      month,
      count: flights.length,
      pendingRules: result.pending.length,
      conflicts: result.conflicts.length,
      importedIntoWebsite: false,
    });
  }
  await save('pending.json', {
    rules: result.pending,
    conflicts: result.conflicts,
  });
  await save('source-rules.json', { provenance, rules: result.rules });

  // The visible route table is a separate rendering check, not a booking inventory check.
  const visible = JSON.parse(
    await readFile(path.join(root, 'visible-nrt-tables.json'), 'utf8'),
  ) as {
    tables: { rows: { cells: { text: string }[]; weekdays: number[] }[] }[];
  };
  const nrtRules = result.rules.filter((r) => r.rule.destination === 'NRT');
  const visibleRows = visible.tables[0]?.rows || [];
  const domMatches = nrtRules.map(({ rule, ruleIndex }) => ({
    ruleIndex,
    matches: visibleRows.filter(
      (row) =>
        row.cells[0]?.text === `IT${rule.flightNumber}` &&
        row.cells[1]?.text === rule.departureTime.slice(0, 5) &&
        row.cells[2]?.text === rule.arrivalTime.slice(0, 5) &&
        row.cells[4]?.text === rule.operationDateSummary &&
        JSON.stringify(row.weekdays) ===
          JSON.stringify(
            tigerWeekdays.flatMap((d, i) => (rule.daysOfWeek[d] ? [i] : [])),
          ),
    ).length,
  }));
  const groupCount = (values: string[]) =>
    Object.fromEntries(
      [...new Set(values)]
        .sort()
        .map((k) => [k, values.filter((v) => v === k).length]),
    );
  const daily = [];
  for (let date = from; date <= through; date = addTigerDays(date, 1))
    daily.push({
      date,
      flights: result.flights.filter((f) => f.date === date).length,
    });
  const afterHashes = Object.fromEntries(
    await Promise.all(
      protectedFiles.map(async (name) => [
        name,
        hash(await readFile(path.resolve('src/server/data', name))),
      ]),
    ),
  );
  const siteUnchanged =
    JSON.stringify(beforeHashes) === JSON.stringify(afterHashes) &&
    scopeHash ===
      hash(
        await readFile(path.resolve('src/features/flights/airline-scope.ts')),
      );
  const audit = {
    finishedAt: new Date().toISOString(),
    from,
    through,
    provenance,
    rawRules: result.rawRules,
    tpeRules: result.tpeRules,
    timezoneEvidence: enriched ? '../additional-timezones.json' : null,
    flights: result.flights.length,
    daily,
    byDestination: groupCount(result.flights.map((f) => f.destination)),
    byCountry: groupCount(result.flights.map((f) => f.countryCode)),
    byFlightNumber: groupCount(result.flights.map((f) => f.flightNumber)),
    pendingRules: result.pending.length,
    conflictingFlights: result.conflicts.length,
    identicalRuleOverlaps: result.identicalOverlap,
    unknownFields: [
      'aircraft',
      'departureTerminal',
      'arrivalTerminal',
      'gate',
      'counter',
      'actualTimes',
      'availability',
    ],
    nrtVisibleTable: {
      rules: nrtRules.length,
      rows: visibleRows.length,
      matchedRules: domMatches.filter((m) => m.matches === 1).length,
      checks: domMatches,
    },
    protectedWebsiteFiles: {
      beforeHashes,
      afterHashes,
      scopeHash,
      unchanged: siteUnchanged,
    },
    importedIntoWebsite: false,
  };
  await save('audit.json', audit);
  console.log(
    JSON.stringify(
      {
        ...audit,
        daily: undefined,
        protectedWebsiteFiles: { unchanged: siteUnchanged },
        nrtVisibleTable: { ...audit.nrtVisibleTable, checks: undefined },
      },
      null,
      2,
    ),
  );
  if (
    !siteUnchanged ||
    result.pending.length ||
    result.conflicts.length ||
    domMatches.some((m) => m.matches !== 1) ||
    !result.flights.length
  )
    process.exitCode = 1;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
