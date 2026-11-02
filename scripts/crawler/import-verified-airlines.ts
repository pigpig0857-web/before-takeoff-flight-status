// Import the two already verified snapshots. No network or old catalogue writes.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { arrivalAirport } from '../../src/features/flights/destinations';
import { zonedParts, utcOffset } from '../../src/features/flights/journey-time';
import {
  normalizeCollected,
  type SavedFlight,
  type CollectedSnapshot,
} from '../../src/server/providers/collected';

async function main() {
  const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const load = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
  const from = '2026-10-13',
    through = '2026-12-31';
  const configs = [
    {
      code: 'IT',
      name: '台灣虎航',
      kind: 'collected_tigerair' as const,
      filename: 'tigerair-flights.json',
      count: 1601,
      root: 'data/source-samples/crawler/tigerair-research-20261013/verified-with-timezones',
    },
    {
      code: 'JX',
      name: '星宇航空',
      kind: 'collected_starlux' as const,
      filename: 'starlux-flights.json',
      count: 2954,
      root: 'data/source-samples/crawler/additional-airlines-20261013/verified-starlux',
    },
  ];
  const originals = [
    'eva-flights.json',
    'peach-flights.json',
    'peach-booking-checks.json',
    'peach-verification-progress.json',
    'collected-flights.json',
  ];
  const before = Object.fromEntries(
    await Promise.all(
      originals.map(async (n) => [
        n,
        hash(await readFile(path.join('src/server/data', n))),
      ]),
    ),
  );
  const candidates: { filename: string; snapshot: CollectedSnapshot }[] = [];
  for (const c of configs) {
    const verification = await load(
      path.join(c.root, 'independent-verification.json'),
    );
    if (verification.state !== 'passed') throw new Error('Unverified source');
    for (const [name, sha] of Object.entries(verification.outputHashes))
      if (hash(await readFile(path.join(c.root, name))) !== sha)
        throw new Error(`Evidence changed: ${name}`);
    const records: SavedFlight[] = [];
    for (const month of ['2026-10', '2026-11', '2026-12']) {
      const pack = await load(path.join(c.root, `flights-${month}.json`));
      for (const f of pack.flights) {
        if (
          f.origin !== 'TPE' ||
          f.airlineCode !== c.code ||
          f.date < from ||
          f.date > through ||
          f.approvalPending
        )
          throw new Error('Unsupported scope or approval');
        const airport = arrivalAirport(f.destination);
        if (!airport || airport.countryCode !== f.countryCode)
          throw new Error('Unconfirmed airport/country');
        const dep = zonedParts(f.scheduledDeparture, 'Asia/Taipei');
        const arr = zonedParts(f.scheduledArrival, f.arrivalTimeZone);
        if (
          dep.date !== f.date ||
          arr.date !== f.arrivalLocalDate ||
          arr.time !== f.arrivalLocalTime
        )
          throw new Error('Local date/time mismatch');
        const number =
          c.code === 'JX' ? f.publishedFlightNumber : f.flightNumber;
        const tiger = c.code === 'IT';
        const params = new URLSearchParams({
          depAirport: 'TPE',
          arrAirport: f.destination,
          date: f.date,
        });
        const terminal =
          f.departureTerminal === null
            ? null
            : f.departureTerminal === '1'
              ? 'T1'
              : f.departureTerminal === '2'
                ? 'T2'
                : undefined;
        if (terminal === undefined)
          throw new Error('Unknown departure terminal');
        const record: SavedFlight = {
          number,
          airline: c.name,
          date: f.date,
          departure: `${dep.date}T${dep.time}:00+08:00`,
          arrival: `${arr.date}T${arr.time}:00${utcOffset(f.scheduledArrival, f.arrivalTimeZone).replace('UTC', '') || '+00:00'}`,
          arrivalTimeZone: f.arrivalTimeZone,
          airport: f.destination,
          candidateAirport: null,
          destination: airport.city,
          destinationEnglish:
            f.arrivalCity ||
            airport.cityAliases.find((a) => /^[A-Za-z]/.test(a)) ||
            f.destination,
          countryCode: f.countryCode,
          terminal,
          arrivalTerminal: f.arrivalTerminal,
          aircraft: f.aircraft,
          minutes: f.durationMinutes,
          kind: c.kind,
          label: `${c.name}官方預定班表`,
          url: tiger
            ? 'https://www.tigerairtw.com/zh-TW/ready-to-go/flight-schedule'
            : `https://www.starlux-airlines.com/zh-TW/timetable/search-result?${params}`,
          fetchedAt: tiger ? pack.provenance.retrievedAt : f.source.retrievedAt,
          operatingAirline: c.name,
          operatingNumber: number,
          codeshare: false,
          page: null,
          evidence: tiger
            ? {
                file: 'data/source-samples/crawler/tigerair-research-20261013/merged-schedules.json',
                sha256: pack.provenance.rawSha256,
                sourceUrl: pack.provenance.sourceUrl,
                ruleIndexes: f.sourceRuleIndexes,
              }
            : {
                file: path.join(c.root, f.source.file).replaceAll('\\', '/'),
                sha256: f.source.sha256,
                sourceUrl: f.source.sourceUrl,
                rowIndex: f.sourceRow,
              },
        };
        normalizeCollected(record);
        records.push(record);
      }
    }
    if (
      records.length !== c.count ||
      new Set(records.map((r) => `${r.date}|${r.airport}|${r.number}`)).size !==
        c.count
    )
      throw new Error('Count/identity mismatch');
    records.sort(
      (a, b) =>
        a.departure.localeCompare(b.departure) ||
        a.number.localeCompare(b.number),
    );
    const dates = [...new Set(records.map((r) => r.date))].sort();
    candidates.push({
      filename: c.filename,
      snapshot: {
        version: 1,
        importedAt: new Date().toISOString(),
        records,
        coverage: [
          {
            kind: c.kind,
            label: `${c.name}官方預定班表`,
            url:
              c.code === 'IT'
                ? 'https://www.tigerairtw.com/zh-TW/ready-to-go/flight-schedule'
                : 'https://www.starlux-airlines.com/zh-TW/timetable',
            fetchedAt: records.map((r) => r.fetchedAt).sort()[0],
            dates,
            records: records.length,
            description: `${c.name}桃園出發已核對公開預定班表：${from}～${through}（含），${new Set(records.map((r) => r.airport)).size} 個機場；非即時動態，查不到不代表沒有航班。`,
          },
        ],
      },
    });
  }
  const run = path.resolve(
    'data/flight-updates',
    `integrate-new-airlines-${new Date().toISOString().replaceAll(':', '-')}`,
  );
  await mkdir(run, { recursive: true });
  for (const n of originals)
    await writeFile(
      path.join(run, `before-${n}`),
      await readFile(path.join('src/server/data', n)),
      { flag: 'wx' },
    );
  const progress = {
    state: 'validated',
    beforeHashes: before,
    steps: [] as { file: string; count: number; sha256: string }[],
    run,
  };
  const checkpoint = async () =>
    writeFile(
      path.join(run, 'progress.json'),
      JSON.stringify(progress, null, 2),
    );
  await checkpoint();
  for (const c of candidates) {
    const bytes = Buffer.from(JSON.stringify(c.snapshot, null, 2) + '\n');
    const dest = path.join('src/server/data', c.filename);
    try {
      const existing = await readFile(dest);
      if (hash(existing) !== hash(bytes))
        throw new Error(
          'Destination already exists; review instead of overwrite',
        );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      await writeFile(`${dest}.pending`, bytes, { flag: 'wx' });
      await rename(`${dest}.pending`, dest);
    }
    progress.steps.push({
      file: c.filename,
      count: c.snapshot.records.length,
      sha256: hash(bytes),
    });
    await checkpoint();
  }
  for (const [n, sha] of Object.entries(before))
    if (hash(await readFile(path.join('src/server/data', n))) !== sha)
      throw new Error('Existing data changed');
  progress.state = 'imported';
  await checkpoint();
  console.log(JSON.stringify(progress, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
