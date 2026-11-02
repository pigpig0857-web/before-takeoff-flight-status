import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { arrivalAirport } from '../../src/features/flights/destinations';
import {
  normalizeCollected,
  type SavedFlight,
} from '../../src/server/providers/collected';
import {
  returnIdentity,
  type ReturnFlight,
} from '../../src/features/flights/return-types';
const root = 'data/source-samples/crawler/khh-expansion-20261020';
const out = 'data/flight-updates/khh-br-vn-integration-20261020';
const read = async (p: string) => JSON.parse(await fs.readFile(p, 'utf8'));
const sha = (b: Buffer | string) =>
  createHash('sha256').update(b).digest('hex');
async function main() {
  const progress = await read(root + '/staging/progress.json');
  assert.equal(progress.state, 'audited_ready_for_integration');
  const baseline = await read(root + '/website-before.json');
  for (const [file, digest] of Object.entries(baseline))
    assert.equal(
      sha(await fs.readFile('src/server/data/' + file)),
      digest,
      file,
    );
  const staged: any[] = [];
  for (const direction of ['outbound', 'inbound'])
    for (const month of ['2026-10', '2026-11', '2026-12']) {
      const stem = `${root}/staging/${direction}-${month}`;
      const bytes = await fs.readFile(stem + '.json');
      const checkpoint = await read(stem + '.checkpoint.json');
      assert.equal(sha(bytes), checkpoint.sha256);
      const rows = JSON.parse(bytes.toString()).records;
      assert.equal(rows.length, checkpoint.records);
      staged.push(...rows);
    }
  assert.equal(staged.length, 1584);
  assert.equal(new Set(staged.map(returnIdentity)).size, 1584);
  for (const r of staged) {
    assert.equal(sha(await fs.readFile(r.evidence.file)), r.sourceSha256);
    assert.ok(r.date >= '2026-10-20' && r.date <= '2026-12-31');
    assert.equal(
      (Date.parse(r.arrival) - Date.parse(r.departure)) / 60000,
      r.minutes,
    );
  }
  const files = new Map<string, unknown>();
  for (const [code, brand, count] of [
    ['BR', 'eva', 573],
    ['VN', 'vietnam', 219],
  ] as const) {
    const records: SavedFlight[] = staged
      .filter((r) => r.airlineCode === code && r.departureAirport === 'KHH')
      .map((r) => {
        const airport = arrivalAirport(r.arrivalAirport)!;
        assert.ok(airport);
        const url =
          code === 'BR'
            ? r.url
            : `https://www.vietnamairlines.com/vn/en/flightschedule?originLocationCode=KHH&destinationLocationCode=${r.arrivalAirport}&departureDate=${r.date}`;
        return {
          origin: 'KHH',
          number: r.number,
          airline: r.airline,
          date: r.date,
          departure: r.departure,
          arrival: r.arrival,
          arrivalTimeZone: r.arrivalTimeZone,
          airport: r.arrivalAirport,
          candidateAirport: null,
          destination: airport.city,
          destinationEnglish: r.arrivalAirport,
          countryCode: r.countryCode,
          terminal: null,
          arrivalTerminal: null,
          aircraft: null,
          minutes: r.minutes,
          kind: code === 'BR' ? 'collected_eva' : 'collected_vietnam',
          label: r.airline + '官方公布班表',
          url,
          fetchedAt: r.fetchedAt,
          operatingAirline: r.airline,
          operatingNumber: null,
          codeshare: false,
          page: null,
          evidence: {
            file: r.evidence.file,
            sha256: r.sourceSha256,
            sourceUrl: r.url,
            ...(code === 'VN' ? { rowIndex: r.evidence.itemIndex } : {}),
            query: { origin: 'KHH', airport: r.arrivalAirport, date: r.date },
          },
        };
      });
    assert.equal(records.length, count);
    records.forEach(normalizeCollected);
    const file = `src/server/data/kaohsiung-${brand}-flights.json`;
    await assert.rejects(fs.access(file));
    files.set(file, {
      version: 1,
      importedAt: new Date().toISOString(),
      records,
      coverage: [
        {
          kind: records[0].kind,
          label: records[0].label,
          url: records[0].url,
          fetchedAt: records
            .map((r) => r.fetchedAt)
            .sort()
            .at(-1),
          description: '高雄出發官方已公布直飛班表',
          dates: [...new Set(records.map((r) => r.date))].sort(),
          records: records.length,
        },
      ],
    });
  }
  const returnFile = 'src/server/data/return-flights.json';
  const originalBytes = await fs.readFile(returnFile);
  const previous = JSON.parse(originalBytes.toString());
  assert.equal(previous.records.length, 12306);
  const inbound = staged.filter((r) => r.arrivalAirport === 'KHH');
  assert.equal(inbound.length, 792);
  const records = [...previous.records, ...inbound];
  assert.equal(
    new Set(records.map((r: ReturnFlight) => returnIdentity(r))).size,
    13098,
  );
  assert.deepEqual(records.slice(0, 12306), previous.records);
  files.set(returnFile, {
    ...previous,
    version: 4,
    records,
    additionalProvenance: root + '/staging/progress.json',
  });
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(out + '/return-before.json', originalBytes, {
    flag: 'wx',
  });
  await fs.writeFile(out + '/before.json', JSON.stringify(baseline, null, 2), {
    flag: 'wx',
  });
  for (const [file, value] of files) {
    const temp = file + '.khh-import.tmp';
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx',
    });
    await fs.rename(temp, file);
  }
  await fs.writeFile(
    out + '/import.json',
    JSON.stringify(
      {
        state: 'imported',
        importedAt: new Date().toISOString(),
        outbound: 792,
        inbound: 792,
        byAirline: progress.byAirline,
        originalReturnRecordsPreserved: 12306,
        returnTotal: 13098,
        pendingExcluded: 32,
        files: Object.fromEntries(
          await Promise.all(
            [...files.keys()].map(async (file) => [
              file,
              sha(await fs.readFile(file)),
            ]),
          ),
        ),
      },
      null,
      2,
    ),
  );
  console.log(
    'Imported 792 outbound + 792 inbound; all 12306 original returns preserved.',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
