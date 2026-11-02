import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  normalizeCollected,
  type SavedFlight,
  type CollectedSnapshot,
} from '../../src/server/providers/collected';
import { buildGroups, sha } from '../automatic-verification/sources';
import { compareObservation } from '../automatic-verification/compare';
import { verificationKey } from '../../src/server/services/timetable-verification';
import { taipeiDate } from '../../src/lib/time';
const read = async (p: string) =>
  JSON.parse((await fs.readFile(p, 'utf8')).replace(/^\uFEFF/, ''));
const atomic = async (p: string, v: unknown) => {
  const temp = p + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temp, JSON.stringify(v, null, 2) + '\n', { flag: 'wx' });
  await fs.rename(temp, p);
};
async function main() {
  assert.equal(taipeiDate(), '2026-10-15');
  const research = 'data/source-samples/crawler/khh-new-airlines-20261015';
  const base = 'data/automatic-verification',
    daily = base + '/runs/2026-10-15';
  const sources = await read(research + '/sources.json');
  for (const s of sources) {
    assert.equal(sha(await fs.readFile(s.file)), s.sha256);
    const receipt = await read(s.receipt);
    assert.equal(receipt.status, 200);
    assert.equal(receipt.sha256, s.sha256);
    assert.equal(receipt.fetchedAt, s.fetchedAt);
    assert.equal(receipt.url, s.url);
  }
  const snapshots: { target: string; snapshot: CollectedSnapshot }[] = [];
  for (const code of ['MM', 'GK']) {
    const candidate = await read(`${research}/${code}-candidates.json`);
    const records: SavedFlight[] = candidate.records.map((r: any) => {
      const weekday = new Date(r.date + 'T12:00:00Z').getUTCDay() || 7;
      const matches = candidate.rules.filter(
        (rule: any) =>
          rule.number === r.number &&
          rule.airport === r.airport &&
          rule.sourceUrl === r.url &&
          rule.departure === r.departure.slice(11, 16) &&
          rule.arrival === r.arrival.slice(11, 16) &&
          r.date >= rule.first &&
          r.date <= rule.last &&
          (rule.days === 'Daily' || rule.days[weekday - 1] === String(weekday)),
      );
      assert.equal(
        matches.length,
        1,
        `Unique reviewed rule for ${r.number} ${r.date}`,
      );
      const rule = matches[0],
        peach = code === 'MM';
      const source = sources.find((s: any) => s.url === r.url)!;
      assert.equal(source.sha256, r.evidence.sha256);
      assert.equal(source.fetchedAt, r.fetchedAt);
      return {
        origin: 'KHH',
        number: r.number,
        airline: r.airline,
        date: r.date,
        departure: r.departure,
        arrival: r.arrival,
        arrivalTimeZone: r.arrivalTimeZone,
        airport: r.airport,
        candidateAirport: null,
        destination: r.destination,
        destinationEnglish: r.airport,
        countryCode: r.countryCode,
        terminal: peach ? null : 'INT',
        arrivalTerminal: peach ? null : r.airport === 'NRT' ? '3' : 'INT',
        aircraft: null,
        minutes: r.minutes,
        kind: peach ? 'collected_peach' : 'collected_jetstar',
        label: `${r.airline}官方公布班表（高雄出發）`,
        url: r.url,
        fetchedAt: r.fetchedAt,
        operatingAirline: r.airline,
        operatingNumber: peach ? r.number : null,
        codeshare: false,
        page: 1,
        sourcePublishedAt: peach
          ? rule.season === 'summer'
            ? '2026-07-06'
            : '2026-09-16'
          : rule.season === 'summer'
            ? '2026-02-03'
            : '2026-09-09',
        sourceNotice:
          r.sourceNotice +
          '機型、櫃台與登機門未公布；航廈僅在官方班表航線標頭有提供時顯示。',
        ...(peach
          ? {}
          : {
              terminalReference: {
                basis: 'published_timetable_route_header' as const,
                url: r.url,
                fetchedAt: r.fetchedAt,
              },
            }),
        evidence: {
          file: r.evidence.file,
          sha256: r.evidence.sha256,
          sourceUrl: r.url,
          ...(peach
            ? { rowIndex: rule.rowIndex }
            : { lineIndex: rule.lineIndex }),
        },
      };
    });
    records.forEach(normalizeCollected);
    assert.equal(records.length, code === 'MM' ? 78 : 89);
    assert.equal(new Set(records.map(verificationKey)).size, records.length);
    snapshots.push({
      target: `src/server/data/kaohsiung-${code === 'MM' ? 'peach' : 'jetstar'}-flights.json`,
      snapshot: {
        version: 1,
        importedAt: new Date().toISOString(),
        records,
        coverage: [...new Set(records.map((r) => r.url))].map((url) => {
          const rows = records.filter((r) => r.url === url);
          return {
            kind: rows[0].kind,
            label: rows[0].label,
            url,
            fetchedAt: rows[0].fetchedAt,
            description:
              '高雄出發官方已公布季節班表；非即時動態，未涵蓋全部航空公司。',
            dates: [...new Set(rows.map((r) => r.date))].sort(),
            records: rows.length,
          };
        }),
      },
    });
  }
  for (const { target } of snapshots) {
    try {
      await fs.access(target);
      throw new Error('Refuse duplicate import');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  const lock = await fs.open(base + '/run.lock', 'wx');
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    const job = await read(daily + '/progress.json'),
      ledger = await read(base + '/latest.json');
    const priorEntries = structuredClone(ledger.entries),
      originals = structuredClone(job.originals);
    for (const [file, digest] of Object.entries(originals))
      assert.equal(sha(await fs.readFile(file)), digest);
    const run = `data/flight-updates/khh-mm-gk-import-${Date.now()}`;
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
      added: 167,
      originals,
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
      'kaohsiung',
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
    const records = snapshots.flatMap((s) => s.snapshot.records);
    const groups = buildGroups([...old, ...records], {
      evaPublicForm: true,
      from: job.from,
    });
    const extra = groups.filter((g) => !job.groupIDs.includes(g.id));
    assert.equal(extra.length, 4);
    for (const group of extra) {
      const s = sources.find((s: any) => s.url === group.url)!,
        stem = `${daily}/${group.id}`;
      await fs.writeFile(stem + '.body', await fs.readFile(s.file), {
        flag: 'wx',
      });
      await fs.writeFile(
        stem + '.receipt.json',
        JSON.stringify(
          { ...(await read(s.receipt)), originalEvidence: s.file },
          null,
          2,
        ),
        { flag: 'wx' },
      );
      group.records.forEach((r) =>
        assert.ok(!ledger.entries[verificationKey(r)]),
      );
      const observations = group.records.map((r) => ({
        origin: r.origin,
        number: r.number,
        date: r.date,
        airport: r.airport!,
        departure: r.departure,
        arrival: r.arrival,
        minutes: r.minutes,
      }));
      const compared = compareObservation(
        group.records,
        observations,
        s.fetchedAt,
        path.resolve(stem + '.body'),
        ledger,
      );
      assert.equal(compared.verified, group.records.length);
      await atomic(stem + '.comparison.json', {
        kind: group.kind,
        origin: 'KHH',
        scope: 'saved_rows_only',
        at: s.fetchedAt,
        compared,
        observations,
        evidenceFile: path.resolve(stem + '.body'),
      });
      job.completed[group.id] = {
        state: 'compared',
        kind: group.kind,
        origin: 'KHH',
        records: group.records.length,
        verified: group.records.length,
        changed: 0,
        notListed: 0,
        added: 0,
        importEvidence: run,
      };
    }
    for (const { target, snapshot } of snapshots) {
      await fs.writeFile(target, JSON.stringify(snapshot, null, 2) + '\n', {
        flag: 'wx',
      });
      job.originals[target] = sha(await fs.readFile(target));
      job.catalogueTransitions = [
        ...(job.catalogueTransitions || []),
        {
          file: target,
          before: null,
          after: job.originals[target],
          added: snapshot.records.length,
          origin: 'KHH',
          evidence: run,
          at: snapshot.importedAt,
        },
      ];
    }
    for (const [key, entry] of Object.entries(priorEntries))
      assert.deepEqual(ledger.entries[key], entry);
    for (const [file, digest] of Object.entries(originals))
      assert.equal(sha(await fs.readFile(file)), digest);
    job.groupIDs = groups.map((g) => g.id);
    job.records += 167;
    job.totalGroups = groups.length;
    job.summary.completedGroups += 4;
    job.summary.totalGroups = groups.length;
    job.summary.verifiedRows += 167;
    job.summary.importedAdditionalRows =
      (job.summary.importedAdditionalRows || 0) + 167;
    job.summary.originalFilesUnchanged = Object.keys(job.originals).length;
    ledger.updatedAt = job.savedAt = new Date().toISOString();
    await atomic(base + '/latest.json', ledger);
    await atomic(daily + '/progress.json', job);
    await atomic(run + '/progress.json', {
      state: 'imported_pending_website_tests',
      added: 167,
      khhTotal: 804,
      originals,
      oldLedgerEntriesUnchanged: Object.keys(priorEntries).length,
      newGroups: extra.map((g) => g.id),
      networkRequests: 0,
    });
    console.log(JSON.stringify({ run, added: 167, khhTotal: 804 }));
  } finally {
    await lock.close();
    await fs.unlink(base + '/run.lock');
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
