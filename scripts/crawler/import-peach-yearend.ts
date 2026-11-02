/** Validate the audited Peach snapshot and prepare an update; never overwrite live data. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { prepareUpdate } from '../flight-updates/store';
import { taipeiDate } from '../../src/lib/time';
import {
  normalizeCollected,
  type CollectedSnapshot,
  type SavedFlight,
} from '../../src/server/providers/collected';

async function main() {
  const root = path.resolve('data/cache/peach-yearend');
  const audit = JSON.parse(
    await fs.readFile(path.join(root, 'audit.json'), 'utf8'),
  );
  assert.equal(audit.status, 'passed');
  assert.equal(audit.tests.failed, 0);
  assert.equal(audit.tests.observedExitCode, 0);
  assert.equal(audit.manualTimetableComparison.mismatches, 0);
  for (const [file, sha] of Object.entries(audit.fileSha256)) {
    assert.ok(
      ['flights.json', 'coverage.json', 'rules.json', 'flights.csv'].includes(
        file,
      ),
    );
    const body = await fs.readFile(path.join(root, file));
    assert.equal(
      createHash('sha256').update(body).digest('hex'),
      sha,
      `Audit mismatch: ${file}`,
    );
  }
  const candidate = JSON.parse(
    await fs.readFile(path.join(root, 'flights.json'), 'utf8'),
  );
  assert.equal(candidate.version, 1);
  assert.equal(candidate.requestedFrom, '2026-10-12');
  assert.equal(candidate.requestedTo, '2026-12-31');
  assert.equal(candidate.departureAirport, 'TPE');
  assert.equal(candidate.records.length, audit.records);
  assert.equal(candidate.records.length, 885);
  const sources = new Map<string, any>(
    candidate.sources.map((source: any) => [source.url, source]),
  );
  const identities = new Set<string>();
  const records: SavedFlight[] = candidate.records.map((r: any) => {
    assert.equal(r.departureAirport, 'TPE');
    assert.equal(r.nonstop, true);
    assert.equal(r.kind, 'collected_peach');
    assert.ok(
      r.date >= candidate.requestedFrom && r.date <= candidate.requestedTo,
    );
    const source = sources.get(r.url);
    assert.ok(source);
    assert.equal(r.sourceSha256, source.sha256);
    assert.equal(r.fetchedAt, source.fetchedAt);
    assert.equal(r.sourcePublishedAt, source.publishedAt);
    assert.ok(r.date >= source.from && r.date <= source.to);
    const number = r.sourceNumber;
    assert.equal(number.replace(/^MM0+(?=\d)/, 'MM'), r.number);
    const record: SavedFlight = {
      number,
      airline: r.airline,
      date: r.date,
      departure: r.departure,
      arrival: r.arrival,
      arrivalTimeZone: r.arrivalTimeZone,
      airport: r.airport,
      candidateAirport: null,
      destination: r.destination,
      destinationEnglish: r.destinationEnglish,
      countryCode: r.countryCode,
      terminal: r.terminal,
      arrivalTerminal: r.arrivalTerminal,
      aircraft: r.aircraft,
      minutes: r.minutes,
      kind: 'collected_peach',
      label: r.label,
      url: r.url,
      fetchedAt: r.fetchedAt,
      operatingAirline: r.operatingAirline,
      operatingNumber: number,
      codeshare: r.codeshare,
      page: r.page,
      sourcePublishedAt: r.sourcePublishedAt,
    };
    normalizeCollected(record);
    const identity = `${r.date}:${r.number}:${r.airport}`;
    assert.ok(!identities.has(identity), 'Duplicate daily identity');
    identities.add(identity);
    return record;
  });
  const dates = [...new Set(records.map((r) => r.date))].sort();
  assert.equal(dates.length, 81);
  assert.equal(new Set(records.map((r) => r.airport)).size, 5);
  const snapshot: CollectedSnapshot = {
    version: 1,
    importedAt: new Date().toISOString(),
    records,
    coverage: [
      {
        kind: 'collected_peach',
        label: '樂桃官方預定班表',
        url: 'https://www.flypeach.com/en/lm/st/routemap',
        fetchedAt: candidate.sources.map((s: any) => s.fetchedAt).sort()[0],
        dates,
        records: records.length,
        description:
          '樂桃航空：2026/10/12～12/31，885 筆桃園出發預定班次，5 個日本機場；依官方夏季與冬季班表整理，非即時動態。',
      },
    ],
  };
  const output = path.join(root, 'website-candidate-' + randomUUID() + '.json');
  await fs.writeFile(output, JSON.stringify(snapshot, null, 2) + '\n', {
    flag: 'wx',
  });
  const result = await prepareUpdate(
    path.resolve('.'),
    'peach',
    output,
    taipeiDate(),
  );
  console.log(
    JSON.stringify(
      {
        ...result,
        integratedIntoWebsite: false,
        message: 'Preview only; review the update package before applying.',
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
