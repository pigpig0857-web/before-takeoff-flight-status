import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  normalizeCollected,
  type SavedFlight,
} from '../../src/server/providers/collected';
import { arrivalAirport } from '../../src/features/flights/destinations';
const root = 'data/source-samples/crawler/thai-lion-20261020';
const read = async (file: string) =>
  JSON.parse(await fs.readFile(file, 'utf8'));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function main() {
  const progress = await read(root + '/progress.json');
  assert.equal(progress.state, 'available_sources_staged');
  const candidates = (await read(root + '/candidates.json')).records as any[];
  assert.equal(candidates.length, 49);
  const existing = await fs.readFile('src/server/data/return-flights.json');
  const returns = JSON.parse(existing.toString());
  assert.equal(returns.records.length, 13103);
  const before: Record<string, string> = {};
  for (const file of (await fs.readdir('src/server/data')).filter((f) =>
    f.endsWith('.json'),
  ))
    before[file] = sha(await fs.readFile('src/server/data/' + file));
  for (const r of candidates)
    assert.equal(sha(await fs.readFile(r.evidence.file)), r.sourceSha256);
  const files = new Map<string, any>();
  for (const origin of ['TPE', 'KHH'] as const) {
    const records: SavedFlight[] = candidates
      .filter((r) => r.departureAirport === origin)
      .map((r) => {
        const airport = arrivalAirport(r.arrivalAirport)!;
        assert.ok(airport);
        return {
          origin,
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
          countryCode: airport.countryCode,
          terminal: null,
          arrivalTerminal: null,
          aircraft: null,
          minutes: r.minutes,
          kind: 'collected_lion',
          label: '泰獅航空官方機場公布班表',
          url: r.url,
          fetchedAt: r.fetchedAt,
          operatingAirline: r.airline,
          operatingNumber: r.number,
          codeshare: false,
          page: null,
          sourceNotice:
            (r.url.includes('naha-airport.co.jp')
              ? '那霸機場官方已公布的10月預定班表。'
              : r.sourceNotice || '官方機場公布班表。') +
            ' 僅涵蓋已公布的10月日期，非訂位或可售機位資訊。',
          evidence: {
            file: r.evidence.file,
            sha256: r.sourceSha256,
            sourceUrl: r.url,
            rowIndex: r.evidence.rowIndex,
            query: { origin, airport: r.arrivalAirport, date: r.date },
          },
        };
      });
    records.forEach(normalizeCollected);
    assert.equal(records.length, origin === 'TPE' ? 10 : 17);
    const urls = [...new Set(records.map((r) => r.url))];
    const file = `src/server/data/${origin === 'KHH' ? 'kaohsiung-' : ''}thai-lion-flights.json`;
    await assert.rejects(fs.access(file));
    files.set(file, {
      version: 1,
      importedAt: new Date().toISOString(),
      records,
      coverage: urls.map((url) => {
        const rows = records.filter((r) => r.url === url);
        return {
          kind: 'collected_lion',
          label: '泰獅航空官方機場公布班表',
          url,
          fetchedAt: rows[0].fetchedAt,
          description: '10月已公布航段；尚未涵蓋11、12月及全部航線',
          dates: [...new Set(rows.map((r) => r.date))].sort(),
          records: rows.length,
        };
      }),
    });
  }
  const inbound = candidates.filter((r) =>
    ['TPE', 'KHH'].includes(r.arrivalAirport),
  );
  assert.equal(inbound.length, 22);
  const identity = (r: any) =>
    [r.date, r.number, r.departureAirport, r.arrivalAirport].join('|');
  const all = [
    ...returns.records,
    ...inbound.map((r) => ({
      ...r,
      sourceNotice: r.url.includes('naha-airport.co.jp')
        ? '那霸機場官方已公布的10月預定班表；非即時動態或可售機位資訊。'
        : r.sourceNotice,
    })),
  ];
  assert.equal(new Set(all.map(identity)).size, 13125);
  assert.deepEqual(all.slice(0, 13103), returns.records);
  files.set('src/server/data/return-flights.json', {
    ...returns,
    version: 6,
    records: all,
  });
  await fs.mkdir(root + '/integration', { recursive: true });
  await fs.writeFile(root + '/integration/return-before.json', existing, {
    flag: 'wx',
  });
  await fs.writeFile(
    root + '/integration/before.json',
    JSON.stringify(before, null, 2),
    { flag: 'wx' },
  );
  for (const [file, value] of files) {
    await fs.writeFile(
      file + '.lion.tmp',
      JSON.stringify(value, null, 2) + '\n',
      { flag: 'wx' },
    );
    await fs.rename(file + '.lion.tmp', file);
  }
  for (const [file, digest] of Object.entries(before))
    if (file !== 'return-flights.json')
      assert.equal(sha(await fs.readFile('src/server/data/' + file)), digest);
  await fs.writeFile(
    root + '/integration/import.json',
    JSON.stringify(
      {
        state: 'imported_partial_official_scope',
        outbound: 27,
        inbound: 22,
        existingPreserved: 13103,
        returnTotal: 13125,
        conflictsExcluded: 4,
        from: '2026-10-20',
        through: '2026-10-31',
      },
      null,
      2,
    ),
  );
  await fs.writeFile(
    root + '/progress.json',
    JSON.stringify(
      {
        ...progress,
        state: 'imported_partial_official_scope',
        websiteImported: true,
        importedOutbound: 27,
        importedInbound: 22,
        returnTotal: 13125,
      },
      null,
      2,
    ),
  );
  console.log(
    'Imported 27 departures + 22 returns; 4 conflicts excluded; prior 13103 returns preserved.',
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
