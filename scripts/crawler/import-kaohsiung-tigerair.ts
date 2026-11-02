import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expandTigerSnapshot } from '../../src/server/providers/experimental/tigerair-schedule';
import {
  normalizeCollected,
  type SavedFlight,
  type CollectedSnapshot,
} from '../../src/server/providers/collected';
import { arrivalAirport } from '../../src/features/flights/destinations';
import { buildGroups, sha } from '../automatic-verification/sources';
import { compareObservation } from '../automatic-verification/compare';
import { verificationKey } from '../../src/server/services/timetable-verification';
import { taipeiDate } from '../../src/lib/time';
import { zonedParts, utcOffset } from '../../src/features/flights/journey-time';
const wall = (iso: string, zone: string) => {
  const v = zonedParts(iso, zone);
  return `${v.date}T${v.time}:00${utcOffset(iso, zone).replace('UTC', '')}`;
};
const read = async (p: string) =>
  JSON.parse((await fs.readFile(p, 'utf8')).replace(/^\uFEFF/, ''));
const atomic = async (p: string, value: unknown) => {
  const temp = p + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
  await fs.rename(temp, p);
};
async function main() {
  assert.equal(
    taipeiDate(),
    '2026-10-15',
    'This migration requires explicitly reviewed saved evidence',
  );
  const base = 'data/automatic-verification',
    daily = base + '/runs/2026-10-15',
    target = 'src/server/data/kaohsiung-flights.json';
  const source = daily + '/7317618ec21263abe5474e1c.body';
  const bytes = await fs.readFile(source),
    receipt = await read(source.replace(/\.body$/, '.receipt.json'));
  assert.equal(receipt.status, 200);
  assert.equal(sha(bytes), receipt.sha256);
  assert.equal(
    receipt.url,
    'https://api-cms.tigerairtw.com/api/flight-schedules/merge',
  );
  const parsed = expandTigerSnapshot(
    JSON.parse(bytes.toString('utf8')),
    '2026-10-15',
    '2026-12-31',
    {},
    'KHH',
  );
  assert.equal(parsed.pending.length, 0);
  assert.equal(parsed.conflicts.length, 0);
  assert.equal(parsed.flights.length, 637);
  assert.equal(new Set(parsed.flights.map((f) => f.destination)).size, 14);
  const records: SavedFlight[] = parsed.flights.map((f) => ({
    origin: 'KHH',
    number: f.flightNumber,
    airline: '台灣虎航',
    date: f.date,
    departure: wall(f.scheduledDeparture, 'Asia/Taipei'),
    arrival: wall(f.scheduledArrival, f.arrivalTimeZone),
    arrivalTimeZone: f.arrivalTimeZone,
    airport: f.destination,
    candidateAirport: null,
    destination: arrivalAirport(f.destination)!.city,
    destinationEnglish: f.destination,
    countryCode: f.countryCode,
    terminal: null,
    arrivalTerminal: null,
    aircraft: null,
    minutes: f.durationMinutes,
    kind: 'collected_tigerair',
    label: '台灣虎航官方預定班表（高雄出發）',
    url: 'https://www.tigerairtw.com/zh-TW/ready-to-go/flight-schedule',
    fetchedAt: receipt.fetchedAt,
    operatingAirline: '台灣虎航',
    operatingNumber: f.flightNumber,
    codeshare: false,
    page: null,
    sourceNotice:
      '高雄 KHH 出發的官方公布預定班表；依適用日期與星期整理，非即時動態。來源未公布逐班機型、航廈、櫃台與登機門。',
    evidence: {
      file: source,
      sourceUrl: receipt.url,
      sha256: receipt.sha256,
      ruleIndexes: f.sourceRuleIndexes,
    },
  }));
  records.forEach(normalizeCollected);
  assert.equal(new Set(records.map(verificationKey)).size, 637);
  const snapshot: CollectedSnapshot = {
    version: 1,
    importedAt: new Date().toISOString(),
    records,
    coverage: [
      {
        kind: 'collected_tigerair',
        label: '台灣虎航高雄出發官方班表',
        url: records[0].url,
        fetchedAt: receipt.fetchedAt,
        dates: [...new Set(records.map((r) => r.date))].sort(),
        records: records.length,
        description:
          '高雄 KHH 出發：目前僅收錄台灣虎航，2026/10/15～12/31 官方已公布班表；並非高雄全部航空公司或即時動態。',
      },
    ],
  };
  const lock = await fs.open(base + '/run.lock', 'wx');
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    try {
      await fs.access(target);
      throw new Error('Refuse duplicate import');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const job = await read(daily + '/progress.json'),
      ledger = await read(base + '/latest.json');
    const priorEntries = structuredClone(ledger.entries);
    for (const [file, digest] of Object.entries(job.originals))
      assert.equal(sha(await fs.readFile(file)), digest);
    const run = `data/flight-updates/kaohsiung-import-${Date.now()}`;
    await fs.mkdir(run, { recursive: true });
    for (const [name, file] of [
      ['progress', daily + '/progress.json'],
      ['ledger', base + '/latest.json'],
      ['completion', base + '/COMPLETION_STATUS.json'],
    ])
      await fs.writeFile(
        `${run}/before-${name}.json`,
        await fs.readFile(file),
        { flag: 'wx' },
      );
    await atomic(run + '/progress.json', {
      state: 'validated_before_import',
      records: 637,
      rules: parsed.rules,
      originalHashes: job.originals,
    });
    const old: SavedFlight[] = [];
    for (const brand of [
      'eva',
      'peach',
      'tigerair',
      'starlux',
      'jeju',
      'vietnam',
      'jta',
      'jetstar',
      'philippine',
    ])
      old.push(
        ...(await read(`src/server/data/${brand}-flights.json`)).records.filter(
          (r: SavedFlight) => r.date >= job.from && r.date <= job.through,
        ),
      );
    assert.deepEqual(
      buildGroups(old, { evaPublicForm: true, from: job.from }).map(
        (g) => g.id,
      ),
      job.groupIDs,
    );
    const groups = buildGroups([...old, ...records], {
      evaPublicForm: true,
      from: job.from,
    });
    const extra = groups.filter((g) => g.records[0].origin === 'KHH');
    assert.equal(extra.length, 1);
    const group = extra[0],
      stem = `${daily}/${group.id}`;
    await fs.writeFile(stem + '.body', bytes, { flag: 'wx' });
    await fs.writeFile(
      stem + '.receipt.json',
      JSON.stringify({ ...receipt, originalEvidence: source }, null, 2),
      { flag: 'wx' },
    );
    const observations = records.map((r) => ({
      origin: r.origin,
      number: r.number,
      date: r.date,
      airport: r.airport!,
      departure: r.departure,
      arrival: r.arrival,
      minutes: r.minutes,
    }));
    records.forEach((r) => assert.ok(!ledger.entries[verificationKey(r)]));
    const compared = compareObservation(
      records,
      observations,
      receipt.fetchedAt,
      path.resolve(stem + '.body'),
      ledger,
    );
    assert.equal(compared.verified, 637);
    await atomic(stem + '.comparison.json', {
      kind: group.kind,
      origin: 'KHH',
      scope: 'queried',
      at: receipt.fetchedAt,
      compared,
      observations,
      evidenceFile: path.resolve(stem + '.body'),
    });
    await fs.writeFile(target, JSON.stringify(snapshot, null, 2) + '\n', {
      flag: 'wx',
    });
    job.completed[group.id] = {
      state: 'compared',
      kind: group.kind,
      origin: 'KHH',
      records: 637,
      verified: 637,
      changed: 0,
      notListed: 0,
      added: 0,
      importEvidence: run,
    };
    job.groupIDs = groups.map((g) => g.id);
    job.records += 637;
    job.totalGroups = groups.length;
    job.summary.completedGroups++;
    job.summary.totalGroups = groups.length;
    job.summary.verifiedRows += 637;
    job.summary.importedAdditionalRows =
      (job.summary.importedAdditionalRows || 0) + 637;
    job.originals[target] = sha(await fs.readFile(target));
    job.summary.originalFilesUnchanged = Object.keys(job.originals).length;
    job.catalogueTransitions = [
      ...(job.catalogueTransitions || []),
      {
        file: target,
        before: null,
        after: job.originals[target],
        added: 637,
        origin: 'KHH',
        evidence: run,
        at: new Date().toISOString(),
      },
    ];
    for (const [key, entry] of Object.entries(priorEntries))
      assert.deepEqual(ledger.entries[key], entry);
    ledger.updatedAt = new Date().toISOString();
    job.savedAt = ledger.updatedAt;
    await atomic(base + '/latest.json', ledger);
    await atomic(daily + '/progress.json', job);
    for (const [file, digest] of Object.entries(job.originals))
      assert.equal(sha(await fs.readFile(file)), digest);
    await atomic(run + '/progress.json', {
      state: 'imported_pending_website_tests',
      records: 637,
      dates: snapshot.coverage[0].dates.length,
      routes: [...new Set(records.map((r) => r.airport))],
      countries: [...new Set(records.map((r) => r.countryCode))],
      rules: parsed.rules,
      oldCatalogueFilesUnchanged: Object.keys(job.originals).length - 1,
      oldLedgerEntriesUnchanged: Object.keys(priorEntries).length,
      networkRequests: 0,
      source,
      sourceSHA256: receipt.sha256,
    });
    console.log(
      JSON.stringify({
        run,
        records: 637,
        routes: 14,
        dates: snapshot.coverage[0].dates.length,
      }),
    );
  } finally {
    await lock.close();
    await fs.unlink(base + '/run.lock');
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
