// Independent TS day enumeration / existing date parser / timezone conversion.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  tigerDatePeriods,
  tigerWeekdays,
  type TigerSnapshot,
} from '../../src/server/providers/experimental/tigerair-schedule';
import {
  localArrival,
  planArrival,
} from '../../src/features/flights/journey-time';

async function main() {
  const root = 'data/source-samples/crawler/return-expansion-20261019';
  const out = path.join(root, 'tigerair-returns');
  const read = async (file: string) =>
    JSON.parse(await fs.readFile(file, 'utf8'));
  const sha = async (file: string) =>
    createHash('sha256')
      .update(await fs.readFile(file))
      .digest('hex');
  const raw: TigerSnapshot = await read(path.join(root, 'tigerair-raw.json'));
  const receipt = await read(path.join(root, 'tigerair-receipt.json'));
  assert.equal(await sha(path.join(root, 'tigerair-raw.json')), receipt.sha256);
  const records = (
    await Promise.all(
      ['2026-10', '2026-11', '2026-12'].map(async (month) => {
        const file = path.join(out, `flights-${month}.json`);
        const check = await read(path.join(out, `checkpoint-${month}.json`));
        assert.equal(await sha(file), check.sha256);
        const batch = (await read(file)).records;
        assert.equal(batch.length, check.records);
        return batch;
      }),
    )
  ).flat();
  const saved = new Map(records.map((r) => [r.id, r]));
  assert.equal(saved.size, records.length);
  const originZones = new Map<string, string>(
    records.map((r) => [r.departureAirport, r.departureTimeZone]),
  );
  const pending = await read(path.join(out, 'pending.json'));
  const rejected = new Map<number, string>(
    pending.rules.map((p: any) => [p.ruleIndex, p.reason]),
  );
  const expected = new Map<string, unknown>();
  const verifiedPending: object[] = [];
  let index = -1;
  for (const country of raw.data)
    for (const station of country.stationSchedules)
      for (const rule of station.schedules) {
        index++;
        if (
          !['TPE', 'KHH'].includes(rule.destination) ||
          ['TPE', 'KHH'].includes(rule.origin)
        )
          continue;
        const periods = tigerDatePeriods(rule.operationDateSummary);
        const rows = [];
        for (
          let ms = Date.parse('2026-10-19T00:00:00Z');
          ms <= Date.parse('2026-12-31T00:00:00Z');
          ms += 86400000
        ) {
          const date = new Date(ms).toISOString().slice(0, 10);
          if (
            !periods.some((p) => p.from <= date && date <= p.through) ||
            !rule.daysOfWeek[tigerWeekdays[new Date(ms).getUTCDay()]]
          )
            continue;
          const dep = localArrival(
            date,
            rule.departureTime.slice(0, 5),
            originZones.get(rule.origin)!,
          );
          const arrivalDate = new Date(ms + rule.overnight * 86400000)
            .toISOString()
            .slice(0, 10);
          const arr = planArrival(
            dep.iso!,
            arrivalDate,
            rule.arrivalTime.slice(0, 5),
            'Asia/Taipei',
          );
          const id = `${date}|${rule.origin}|${rule.destination}|IT${Number(rule.flightNumber)}`;
          rows.push({ id, dep, arr, date });
        }
        const bad = rows.filter(
          (r) =>
            r.arr.minutes !== rule.durationInMinutes ||
            !r.dep.iso ||
            !r.arr.iso,
        );
        if (rejected.has(index)) {
          assert.ok(
            bad.length > 0,
            'Pending rule should have independently reproduced error',
          );
          verifiedPending.push({
            ruleIndex: index,
            affectedDates: rows.map((r) => r.date),
            publishedMinutes: rule.durationInMinutes,
            calculatedMinutes: bad.map((r) => r.arr.minutes),
          });
          continue;
        }
        assert.equal(bad.length, 0, `Unrecorded source issue ${index}`);
        for (const row of rows) {
          const actual = saved.get(row.id);
          assert.ok(actual, `Missing ${row.id}`);
          assert.equal(Date.parse(actual.departure), Date.parse(row.dep.iso!));
          assert.equal(Date.parse(actual.arrival), Date.parse(row.arr.iso!));
          assert.equal(actual.minutes, rule.durationInMinutes);
          assert.ok(actual.sourceRuleIndexes.includes(index));
          assert.equal(actual.sourceSha256, receipt.sha256);
          assert.equal(actual.url, receipt.url);
          for (const k of ['terminal', 'arrivalTerminal', 'aircraft'])
            assert.equal(actual[k], null);
          if (expected.has(row.id))
            assert.deepEqual(expected.get(row.id), [row.dep.iso, row.arr.iso]);
          expected.set(row.id, [row.dep.iso, row.arr.iso]);
        }
      }
  assert.deepEqual([...saved.keys()].sort(), [...expected.keys()].sort());
  const before = await read(path.join(root, 'website-before.json'));
  for (const [name, hash] of Object.entries(before))
    assert.equal(await sha(path.join('src/server/data', name)), hash);
  const report = {
    status: 'passed',
    records: records.length,
    routes: new Set(
      records.map((r) => `${r.departureAirport}-${r.arrivalAirport}`),
    ).size,
    independentMethod:
      'TypeScript daily enumeration, established date range parser and IANA timezone conversion',
    duplicateIdentities: 0,
    websiteDataUnchanged: true,
    sourceHashesMatch: true,
    verifiedPending,
    integratedIntoWebsite: false,
  };
  await fs.writeFile(
    path.join(out, 'independent-audit.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
