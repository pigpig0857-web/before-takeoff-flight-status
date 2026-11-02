// Offline import: verify every row against saved official evidence, preserving old data.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { arrivalAirport } from '../../src/features/flights/destinations';
import {
  normalizeCollected,
  type SavedFlight,
  type CollectedSnapshot,
} from '../../src/server/providers/collected';

const hash = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const cache = new Map<string, any>();
async function load(file: string) {
  if (!cache.has(file))
    cache.set(
      file,
      JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')),
    );
  return cache.get(file);
}
const research = 'data/source-samples/crawler/more-airlines-20261013';
const from = '2026-10-13',
  through = '2026-12-31';
const configs = [
  {
    brand: 'jeju',
    code: '7C',
    name: '濟州航空',
    kind: 'collected_jeju' as const,
    count: 240,
  },
  {
    brand: 'vietnam',
    code: 'VN',
    name: '越南航空',
    kind: 'collected_vietnam' as const,
    count: 219,
  },
];
const originals = [
  'eva-flights.json',
  'peach-flights.json',
  'peach-booking-checks.json',
  'peach-verification-progress.json',
  'collected-flights.json',
  'tigerair-flights.json',
  'starlux-flights.json',
];

async function main() {
  const candidates: { file: string; snapshot: CollectedSnapshot }[] = [];
  for (const config of configs) {
    const root = `${research}/verified-${config.brand}`;
    const audit = await load(`${root}/audit.json`);
    assert.equal(audit.state, 'verified');
    assert.equal(audit.pendingQueries, 0);
    assert.equal(audit.dateAirportCells, 160);
    const pack = await load(`${root}/candidate-flights.json`);
    assert.equal(pack.records.length, config.count);
    for (const month of ['2026-10', '2026-11', '2026-12']) {
      const checkpoint = await load(`${root}/checkpoint-${month}.json`);
      assert.equal(
        hash(await readFile(`${root}/${checkpoint.file}`)),
        checkpoint.sha256,
      );
      assert.deepEqual(
        (await load(`${root}/${checkpoint.file}`)).records,
        pack.records.filter((r: any) => r.date.startsWith(month)),
      );
    }
    const records: SavedFlight[] = [];
    for (const f of pack.records) {
      assert.equal(f.origin, 'TPE');
      assert.ok(f.date >= from && f.date <= through);
      assert.equal(f.operatingAirlineCode, config.code);
      assert.equal(f.codeshare, false);
      assert.equal(f.operatingNumber, null);
      assert.equal(f.gate, null);
      assert.equal(f.counter, null);
      const airport = arrivalAirport(f.airport);
      assert.ok(airport && airport.countryCode === f.countryCode);
      const file = String(f.evidence.file).replaceAll('\\', '/');
      assert.ok(
        path
          .resolve(file)
          .startsWith(path.resolve('data/source-samples/crawler') + path.sep),
      );
      assert.equal(hash(await readFile(file)), f.evidence.sha256);
      const receipt = await load(file.replace(/\.body$/, '.receipt.json'));
      assert.equal(receipt.status, 200);
      assert.equal(receipt.url, f.evidence.url);
      assert.equal(receipt.fetchedAt, f.fetchedAt);
      const raw = await load(file);
      let queryDate: string;
      if (config.code === '7C') {
        assert.equal(raw.code, '0000');
        const published = raw.data.dep[f.evidence.rowIndex];
        assert.equal(
          published.identifier.carrierCode + published.identifier.identifier,
          f.number,
        );
        assert.equal(published.designator.origin, 'TPE');
        assert.equal(published.designator.destination, f.airport);
        assert.equal(published.legDetails.codeShareIndicator, 'NonCodeShare');
        assert.equal(published.designator.departure, f.departure.slice(0, 19));
        assert.equal(published.designator.arrival, f.arrival.slice(0, 19));
        assert.equal(
          Date.parse(published.legDetails.departureTimeUtc),
          Date.parse(f.departure),
        );
        assert.equal(
          Date.parse(published.legDetails.arrivalTimeUtc),
          Date.parse(f.arrival),
        );
        assert.equal(f.aircraft, null);
        assert.equal(f.terminal, null);
        assert.equal(f.arrivalTerminal, null);
        const request = await load(file.replace(/\.body$/, '.started.json'));
        assert.equal(request.body.depStn, 'TPE');
        assert.equal(request.body.arrStn, f.airport);
        queryDate = request.body.startDate.replace(
          /^(\d{4})(\d{2})(\d{2})$/,
          '$1-$2-$3',
        );
      } else {
        assert.equal(raw.success, true);
        const item =
          raw.data.departureFlight.scheduleItems[f.evidence.rowIndex];
        assert.equal(item.connectedFlights.length, 1);
        const segment = item.connectedFlights[0],
          info = segment.flightInfo;
        assert.equal(segment.numberOfStops, 0);
        assert.equal(info.marketingAirlineCode, 'VN');
        assert.equal(info.operatingAirlineCode, 'VN');
        assert.equal(
          info.marketingAirlineCode + info.marketingFlightNumber,
          f.number,
        );
        assert.equal(info.departureLocation.locationCode, 'TPE');
        assert.equal(info.arrivalLocation.locationCode, f.airport);
        assert.equal(info.departureLocation.dateTime, f.departure.slice(0, 19));
        assert.equal(info.arrivalLocation.dateTime, f.arrival.slice(0, 19));
        assert.equal(info.departureLocation.dateTimeZoneGmtOffset, 8);
        assert.equal(info.arrivalLocation.dateTimeZoneGmtOffset, 7);
        assert.equal(info.duration / 60, f.durationMinutes);
        assert.equal(
          raw.data.departureFlight.dictionaries.aircraft[info.airEquipmentCode],
          f.aircraft,
        );
        assert.equal(`T${info.departureLocation.terminal}`, f.terminal);
        assert.equal(info.arrivalLocation.terminal, f.arrivalTerminal);
        assert.ok(
          segment.operatingDays.includes(
            new Date(`${f.date}T12:00:00Z`)
              .toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
              .toLowerCase(),
          ),
        );
        assert.ok(
          segment.validityPeriod.start.slice(0, 10) <= f.date &&
            f.date <= segment.validityPeriod.end.slice(0, 10),
        );
        queryDate = new URL(f.evidence.url).searchParams.get('departureDate')!;
      }
      const url =
        config.code === '7C'
          ? 'https://www.jejuair.net/en/prepare/flight/viewScheduleInfo.do'
          : `https://www.vietnamairlines.com/vn/en/flightschedule?${new URLSearchParams({ originLocationCode: 'TPE', destinationLocationCode: f.airport, departureDate: f.date })}`;
      const record: SavedFlight = {
        number: f.number,
        airline: config.name,
        date: f.date,
        departure: f.departure,
        arrival: f.arrival,
        arrivalTimeZone: f.arrivalTimeZone,
        airport: f.airport,
        candidateAirport: null,
        destination: airport.city,
        destinationEnglish:
          airport.cityAliases.find((name) => /^[A-Za-z]/.test(name)) ||
          f.airport,
        countryCode: f.countryCode,
        terminal: f.terminal,
        arrivalTerminal: f.arrivalTerminal,
        aircraft: f.aircraft,
        minutes: f.durationMinutes,
        kind: config.kind,
        label: `${config.name}官方預定班表`,
        url,
        fetchedAt: f.fetchedAt,
        operatingAirline: config.name,
        operatingNumber: null,
        codeshare: false,
        page: null,
        evidence: {
          file,
          sha256: f.evidence.sha256,
          sourceUrl: f.evidence.url,
          rowIndex: f.evidence.rowIndex,
          query: { origin: 'TPE', airport: f.airport, date: queryDate },
        },
        detail: {
          url,
          fetchedAt: f.fetchedAt,
          departureTerminal: f.terminal,
          arrivalTerminal: f.arrivalTerminal,
          aircraft: f.aircraft,
          scope: 'segment',
          nonstop: true,
        },
      };
      normalizeCollected(record);
      records.push(record);
    }
    assert.equal(
      new Set(records.map((r) => `${r.date}|${r.number}|${r.airport}`)).size,
      config.count,
    );
    const dates = [...new Set(records.map((r) => r.date))].sort();
    assert.equal(dates.length, 80);
    const coverageUrl =
      config.code === '7C'
        ? records[0].url
        : 'https://www.vietnamairlines.com/vn/en/flightschedule';
    candidates.push({
      file: `${config.brand}-flights.json`,
      snapshot: {
        version: 1,
        importedAt: new Date().toISOString(),
        records,
        coverage: [
          {
            kind: config.kind,
            label: `${config.name}官方預定班表`,
            url: coverageUrl,
            fetchedAt: records.map((r) => r.fetchedAt).sort()[0],
            dates,
            records: records.length,
            description:
              config.code === '7C'
                ? `濟州航空桃園出發已核對預定班表：${from}～${through}（含），仁川 ICN、釜山 PUS；來源未提供機型與航廈，非即時動態。`
                : `越南航空桃園出發已核對预定班表：${from}～${through}（含），河內 HAN、胡志明市 SGN，僅收錄越南航空自行執飛班次；尚未確認全部桃園航點，不包含華航承運共用班號，非即時動態。`,
          },
        ],
      },
    });
  }
  const run = path.resolve(
    'data/flight-updates',
    `integrate-jeju-vietnam-${new Date().toISOString().replaceAll(':', '-')}`,
  );
  await mkdir(run, { recursive: true });
  const beforeHashes: Record<string, string> = {};
  for (const name of originals) {
    const bytes = await readFile(`src/server/data/${name}`);
    beforeHashes[name] = hash(bytes);
    await writeFile(path.join(run, `before-${name}`), bytes, { flag: 'wx' });
  }
  const progress = {
    state: 'validated',
    run,
    beforeHashes,
    steps: [] as { file: string; count: number; sha256: string }[],
  };
  const checkpoint = () =>
    writeFile(
      path.join(run, 'progress.json'),
      JSON.stringify(progress, null, 2),
    );
  await checkpoint();
  for (const candidate of candidates) {
    const bytes = Buffer.from(
      JSON.stringify(candidate.snapshot, null, 2) + '\n',
    );
    const dest = `src/server/data/${candidate.file}`;
    // Refuse to replace any pre-existing catalogue.
    try {
      await readFile(dest);
      throw new Error(`Already exists: ${dest}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await writeFile(`${dest}.pending`, bytes, { flag: 'wx' });
    await rename(`${dest}.pending`, dest);
    progress.steps.push({
      file: candidate.file,
      count: candidate.snapshot.records.length,
      sha256: hash(bytes),
    });
    await checkpoint();
  }
  for (const [name, sha] of Object.entries(beforeHashes))
    assert.equal(hash(await readFile(`src/server/data/${name}`)), sha);
  progress.state = 'imported';
  await checkpoint();
  console.log(JSON.stringify(progress, null, 2));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
