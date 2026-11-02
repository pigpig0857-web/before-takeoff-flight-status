import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
// @ts-expect-error Native source table parser.
import { parseTable } from './eva-table-scope.mjs';
import { parseEvaDetail } from './eva-detail';
import {
  normalizeCollected,
  type CollectedSnapshot,
} from '../../src/server/providers/collected';

async function main() {
  const args = process.argv.slice(2),
    python = args[args.indexOf('--python') + 1];
  assert.ok(args.includes('--python') && python, '--python required');
  const root = path.resolve('data/source-samples/crawler/eva-yearend-2026');
  const directory = path.join(root, 'full-details');
  const manifest = JSON.parse(
    await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'),
  );
  const plan = JSON.parse(
    await fs.readFile(path.join(root, 'progress.json'), 'utf8'),
  );
  const samples = JSON.parse(
    await fs.readFile(
      path.join(root, 'detail-crosschecks/manifest.json'),
      'utf8',
    ),
  );
  const output = path.resolve('src/server/data/eva-flights.json');
  const snapshot: CollectedSnapshot = JSON.parse(
    await fs.readFile(output, 'utf8'),
  );
  const entries = new Map<string, any>(
    manifest
      .filter((e: any) => e.status === 'verified')
      .map((e: any) => [`${e.airport}|${e.date}|${e.number}`, e]),
  );
  const detailFiles = [...entries.values()].map((e) =>
    path.resolve(root, e.evidenceFile),
  );
  const batchFile = path.join(directory, 'replay-files.json');
  await fs.writeFile(batchFile, JSON.stringify(detailFiles));
  const parsedDetails = JSON.parse(
    execFileSync(
      python,
      ['scripts/crawler/fetch-eva-form.py', '--parse-detail-batch', batchFile],
      { encoding: 'utf8', maxBuffer: 15000000, timeout: 180000 },
    ),
  );
  const continuations = new Map<string, string>();
  // Per-date source evidence for same-number services continuing beyond Bangkok.
  for (const route of plan.routes.filter((r: any) =>
    ['AMS', 'LHR', 'VIE'].includes(r.airport),
  )) {
    for (const observation of route.observations.filter(
      (o: any) => o.validated,
    )) {
      const raw = await fs.readFile(path.join(root, observation.file));
      const receipt = JSON.parse(
        await fs.readFile(
          path.join(root, observation.file + '.receipt.json'),
          'utf8',
        ),
      );
      assert.equal(receipt.httpStatus, 200);
      assert.equal(
        receipt.sha256,
        createHash('sha256').update(raw).digest('hex'),
      );
      const page = JSON.parse(
        execFileSync(
          python,
          [
            'scripts/crawler/fetch-eva-form.py',
            '--parse-file',
            path.join(root, observation.file),
          ],
          { encoding: 'utf8', maxBuffer: 4000000 },
        ),
      );
      const table = parseTable(page.rows, route.airport, plan.sourceUrl);
      assert.ok(table.completeDirectTable);
      for (const service of table.throughRecords) {
        const key = `${service.date}|${service.number}|${service.departureTime}`;
        assert.ok(
          !continuations.has(key) || continuations.get(key) === route.airport,
          'Conflicting continuation destinations',
        );
        continuations.set(key, route.airport);
      }
    }
  }
  let imported = 0;
  for (const record of snapshot.records) {
    const entry = entries.get(
      `${record.airport}|${record.date}|${record.number}`,
    );
    if (entry) {
      const evidencePath = path.resolve(root, entry.evidenceFile);
      assert.ok(
        evidencePath.startsWith(root + path.sep),
        'Evidence outside source directory',
      );
      const raw = await fs.readFile(evidencePath);
      const receipt = JSON.parse(
        await fs.readFile(evidencePath + '.receipt.json', 'utf8'),
      );
      assert.equal(receipt.httpStatus, 200);
      assert.equal(receipt.sha256, entry.sha256);
      assert.equal(
        createHash('sha256').update(raw).digest('hex'),
        entry.sha256,
      );
      const observed = plan.routes
        .find((r: any) => r.airport === record.airport)
        .records.find(
          (r: any) => r.date === record.date && r.number === record.number,
        );
      assert.equal(receipt.url, observed.detailLink);
      const parsed = parsedDetails[evidencePath];
      const reference = samples.find((s: any) => s.airport === record.airport);
      const detail = parseEvaDetail(parsed.detailText, {
        ...observed,
        minutes: record.minutes,
        arrivalLabel: reference.arrivalLabel,
      });
      assert.deepEqual(entry.evidence, {
        ...detail,
        url: receipt.url,
        fetchedAt: receipt.observedAt,
      });
      record.terminal = detail.departureTerminal;
      record.arrivalTerminal = detail.arrivalTerminal;
      record.aircraft = detail.aircraft;
      record.detail = {
        url: receipt.url,
        fetchedAt: receipt.observedAt,
        departureTerminal: detail.departureTerminal,
        arrivalTerminal: detail.arrivalTerminal,
        aircraft: detail.aircraft,
        scope: detail.scope,
        nonstop: detail.nonstop,
      };
      imported++;
    }
    const continuation =
      record.airport === 'BKK' &&
      continuations.get(
        `${record.date}|${record.number}|${record.departure.slice(11, 16)}`,
      );
    if (continuation) record.continuationAirport = continuation;
    normalizeCollected(record);
  }
  assert.ok(imported > 0);
  snapshot.importedAt = new Date().toISOString();
  await fs.copyFile(
    output,
    path.join(directory, `website-before-enrichment-${Date.now()}.json`),
  );
  await fs.writeFile(output + '.tmp', JSON.stringify(snapshot) + '\n');
  await fs.rename(output + '.tmp', output);
  const report = {
    importedAt: snapshot.importedAt,
    total: snapshot.records.length,
    detailsVerified: imported,
    detailsMissing: snapshot.records.length - imported,
    departureTerminal: snapshot.records.filter((r) => r.terminal).length,
    arrivalTerminal: snapshot.records.filter((r) => r.arrivalTerminal).length,
    aircraft: snapshot.records.filter((r) => r.aircraft).length,
    continuationSegments: snapshot.records.filter((r) => r.continuationAirport)
      .length,
    allPublishedFlightsGuaranteed: false,
  };
  await fs.writeFile(
    path.join(directory, 'website-import.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
