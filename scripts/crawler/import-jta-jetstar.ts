// Import only the completed, checkpointed research; retain existing catalogues.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeCollected,
  type SavedFlight,
  type CollectedSnapshot,
} from '../../src/server/providers/collected';

const root = 'data/source-samples/crawler/jta-jetstar-completeness-20261014';
const baseline = 'data/source-samples/crawler/new-airlines-20261014';
const run = 'data/flight-updates/integrate-jta-jetstar-20261014';
const hash = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const cache = new Map<string, any>();
async function load(file: string): Promise<any> {
  if (!cache.has(file))
    cache.set(
      file,
      JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')),
    );
  return cache.get(file);
}
async function proof(p: any) {
  const file = String(p.file).replaceAll('\\', '/');
  assert.ok(
    path
      .resolve(file)
      .startsWith(path.resolve('data/source-samples/crawler') + path.sep),
  );
  assert.equal(hash(await readFile(file)), p.sha256);
}
async function main() {
  const originals = (await load(`${baseline}/existing-website-data-check.json`))
    .files;
  for (const [file, value] of Object.entries(originals) as [string, any][])
    assert.equal(
      hash(await readFile(`src/server/data/${file}`)),
      value.sha256,
      file,
    );
  const candidates: { brand: string; snapshot: CollectedSnapshot }[] = [];
  for (const [brand, count] of [
    ['jta', 148],
    ['jetstar', 320],
  ] as const) {
    const out = `${root}/verified-${brand}`;
    const audit = await load(`${out}/audit.json`);
    assert.equal(audit.state, 'core_verified');
    assert.equal(audit.pendingDateFlightChecks, 0);
    assert.equal(audit.sourceConflicts, 0);
    assert.deepEqual(await load(`${out}/pending.json`), []);
    const pack = await load(`${out}/candidate-flights.json`);
    assert.equal(pack.records.length, count);
    for (const batch of (await load(`${out}/checkpoint.json`)).batches) {
      assert.equal(hash(await readFile(`${out}/${batch.file}`)), batch.sha256);
      assert.deepEqual(
        (await load(`${out}/${batch.file}`)).records,
        pack.records.filter((r: any) => r.date.startsWith(batch.month)),
      );
    }
    const records: SavedFlight[] = [];
    for (const f of pack.records) {
      await proof(f.evidence);
      let terminalProof = f.terminalEvidence || f.evidence;
      await proof(terminalProof);
      const p = f.evidence;
      const evidence: NonNullable<SavedFlight['evidence']> = {
        file: p.file.replaceAll('\\', '/'),
        sha256: p.sha256,
        sourceUrl: p.sourceUrl,
      };
      if (f.kind === 'collected_jta') {
        evidence.tableIndex = p.tableIndex;
        evidence.rowIndex = p.rowIndex;
        assert.equal(
          (await load(p.file)).tables[p.tableIndex].rows[p.rowIndex][0],
          f.number,
        );
      } else if (f.kind === 'collected_kix') {
        evidence.cardIndex = p.cardIndex;
        evidence.query = {
          origin: 'TPE',
          airport: p.query.to,
          date: p.query.date,
        };
        assert.equal(evidence.query.date, f.date);
        assert.equal(
          (await load(p.file.replace(/\.body$/, '.receipt.json'))).status,
          200,
        );
      } else {
        evidence.lineIndex = p.lineIndex;
        assert.ok(p.sourceLine.includes(f.number));
        assert.ok(p.sourceLine.includes(f.departure.slice(11, 16)));
        assert.ok(p.sourceLine.includes(f.arrival.slice(11, 16)));
      }
      const record: SavedFlight = {
        number: f.number,
        airline: f.airline,
        date: f.date,
        departure: f.departure,
        arrival: f.arrival,
        arrivalTimeZone: f.arrivalTimeZone,
        airport: f.airport,
        candidateAirport: null,
        destination: f.destination,
        destinationEnglish: f.destinationEnglish,
        countryCode: f.countryCode,
        terminal: f.terminal,
        arrivalTerminal: f.arrivalTerminal,
        aircraft: f.aircraft,
        minutes: f.minutes,
        kind: f.kind,
        label: f.label,
        url: f.url,
        fetchedAt: f.fetchedAt,
        operatingAirline: f.operatingAirline,
        operatingNumber: null,
        codeshare: false,
        page: f.evidence.page || null,
        ...(f.sourcePublishedAt && { sourcePublishedAt: f.sourcePublishedAt }),
        sourceNotice: f.sourceNotice,
        evidence,
        terminalReference: {
          url: terminalProof.sourceUrl,
          fetchedAt:
            terminalProof.fetchedAt ||
            (await load(terminalProof.file.replace(/\.body$/, '.receipt.json')))
              .fetchedAt,
          basis:
            brand === 'jta'
              ? 'published_airline_airport_guide'
              : 'published_timetable_route_header',
        },
      };
      normalizeCollected(record);
      records.push(record);
    }
    assert.equal(
      new Set(records.map((r) => `${r.date}|${r.number}|${r.airport}`)).size,
      count,
    );
    const kinds = [...new Set(records.map((r) => r.kind))];
    candidates.push({
      brand,
      snapshot: {
        version: 1,
        importedAt: new Date().toISOString(),
        records,
        coverage: kinds.map((kind) => {
          const subset = records.filter((r) => r.kind === kind);
          return {
            kind,
            label: subset[0].label,
            url:
              kind === 'collected_jetstar'
                ? 'https://www.jetstar.com/jp/ja/help/flight-schedules'
                : subset[0].url,
            fetchedAt: subset.map((r) => r.fetchedAt).sort()[0],
            dates: [...new Set(subset.map((r) => r.date))].sort(),
            records: subset.length,
            description:
              kind === 'collected_jta'
                ? '日本越洋航空桃園至沖繩 OKA：2026/10/14～12/31（含）已公布預定班表；航廈依一般官方指南，非即時動態。'
                : kind === 'collected_jetstar'
                  ? '捷星日本航空桃園至東京 NRT、大阪 KIX：2026/10/14～12/31（含）官方 PDF 公布班表；GK50 部分日期另採關西機場公開班表，未公布機型。'
                  : 'GK50 桃園至大阪 KIX：2026/10/26～12/25（含）已逐日核對關西機場公開班表（OAG），非捷星自有班表、非即時動態。',
          };
        }),
      },
    });
  }
  // Validate both airlines before creating either catalogue.
  await mkdir(run, { recursive: true });
  const progress = {
    state: 'validated',
    beforeHashes: Object.fromEntries(
      Object.entries(originals).map(([file, value]: [string, any]) => [
        file,
        value.sha256,
      ]),
    ),
    steps: [] as any[],
  };
  const checkpoint = () =>
    writeFile(`${run}/progress.json`, JSON.stringify(progress, null, 2));
  for (const file of Object.keys(originals))
    await writeFile(
      `${run}/before-${file}`,
      await readFile(`src/server/data/${file}`),
      { flag: 'wx' },
    );
  await checkpoint();
  for (const { brand, snapshot } of candidates) {
    const file = `src/server/data/${brand}-flights.json`;
    try {
      await readFile(file);
      throw new Error(`Refusing to replace existing ${file}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const bytes = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n');
    await writeFile(`${file}.pending`, bytes, { flag: 'wx' });
    await rename(`${file}.pending`, file);
    progress.steps.push({
      file,
      count: snapshot.records.length,
      sha256: hash(bytes),
    });
    await checkpoint();
  }
  for (const [file, expected] of Object.entries(progress.beforeHashes))
    assert.equal(hash(await readFile(`src/server/data/${file}`)), expected);
  progress.state = 'imported';
  await checkpoint();
  console.log(
    JSON.stringify({
      state: progress.state,
      counts: progress.steps.map((s) => s.count),
      preservedOriginals: Object.keys(originals).length,
    }),
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
