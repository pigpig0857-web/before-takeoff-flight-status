/** Replay saved public HTML and hashes before preparing any website records. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
// @ts-expect-error Native ESM evidence parser.
import * as parser from './eva-table-scope.mjs';
import {
  airportTimeZone,
  localArrival,
  utcOffset,
} from '../../src/features/flights/journey-time';
import { arrivalAirport } from '../../src/features/flights/destinations';
async function main() {
  const root = path.resolve('data/source-samples/crawler/eva-yearend-2026');
  const args = process.argv.slice(2),
    python = args[args.indexOf('--python') + 1];
  if (!args.includes('--python')) throw Error('--python required');
  const plan = JSON.parse(
    await fs.readFile(path.join(root, 'progress.json'), 'utf8'),
  );
  const records: any[] = [],
    routes: any[] = [];
  const requested: string[] = [];
  for (
    let t = Date.parse(plan.from);
    t <= Date.parse(plan.through);
    t += 86400000
  )
    requested.push(new Date(t).toISOString().slice(0, 10));
  for (const route of plan.routes) {
    const activeDates = requested.filter(
      (d) => !route.serviceFrom || d >= route.serviceFrom,
    );
    if (route.serviceFrom) {
      assert.equal(route.airport, 'DEL');
      assert.equal(route.serviceFrom, '2026-12-01');
      const evidence = route.serviceStartEvidence;
      assert.equal(
        evidence.sourceUrl,
        'https://www.evaair.com/zh-hk/about-eva-air/news/news-releases/2026-08-05-direct-flights-from-taipei-to-delhi.html',
      );
      const raw = await fs.readFile(path.join(root, evidence.file));
      assert.equal(
        createHash('sha256').update(raw).digest('hex'),
        evidence.sha256,
      );
    }
    const replayed = new Map<string, any>(),
      covered = new Set<string>();
    for (const observation of route.observations.filter(
      (o: any) => o.validated,
    )) {
      assert.equal(path.basename(observation.file), observation.file);
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
          { encoding: 'utf8', timeout: 10000, maxBuffer: 4000000 },
        ),
      );
      const result = parser.parseTable(
        page.rows,
        route.airport,
        plan.sourceUrl,
      );
      assert.equal(result.completeDirectTable, true);
      for (const through of result.throughRecords.filter((r: any) =>
        activeDates.includes(r.date),
      )) {
        const firstLeg = plan.routes
          .find((r: any) => r.airport === 'BKK')
          .records.find(
            (r: any) =>
              r.number === through.number &&
              r.date === through.date &&
              r.departureTime === through.departureTime,
          );
        assert.ok(
          firstLeg,
          `Through service missing first leg ${through.number} ${through.date}`,
        );
      }
      assert.deepEqual(
        result.dates.filter((d: string) => activeDates.includes(d)),
        observation.dates,
      );
      observation.dates.forEach((d: string) => covered.add(d));
      for (const r of result.records.filter((r: any) =>
        activeDates.includes(r.date),
      )) {
        const key = `${r.number}|${r.date}`;
        const previous = replayed.get(key);
        if (previous)
          assert.deepEqual(
            [
              previous.departureTime,
              previous.arrivalTime,
              previous.arrivalDayOffset,
            ],
            [r.departureTime, r.arrivalTime, r.arrivalDayOffset],
          );
        else replayed.set(key, r);
      }
    }
    assert.equal(
      replayed.size,
      route.records.length,
      `Saved/replayed records mismatch ${route.airport}`,
    );
    for (const r of route.records) {
      const replay = replayed.get(`${r.number}|${r.date}`);
      assert.ok(replay);
      assert.deepEqual(
        [r.departureTime, r.arrivalTime, r.arrivalDayOffset, r.detailLink],
        [
          replay.departureTime,
          replay.arrivalTime,
          replay.arrivalDayOffset,
          replay.detailLink,
        ],
      );
      const zone = airportTimeZone(r.airport);
      assert.ok(zone, `Missing zone ${r.airport}`);
      const arrivalDate = new Date(
        Date.parse(r.date) + r.arrivalDayOffset * 86400000,
      )
        .toISOString()
        .slice(0, 10);
      const resolved = localArrival(arrivalDate, r.arrivalTime, zone);
      assert.ok(resolved.iso, `Ambiguous arrival ${r.number} ${r.date}`);
      const departure = `${r.date}T${r.departureTime}:00+08:00`;
      const arrival = `${arrivalDate}T${r.arrivalTime}:00${utcOffset(resolved.iso, zone).replace('UTC', '') || '+00:00'}`;
      const minutes = (Date.parse(arrival) - Date.parse(departure)) / 60000;
      assert.ok(minutes > 0 && minutes <= 1440);
      const airport = arrivalAirport(r.airport);
      assert.ok(airport, `Missing destination ${r.airport}`);
      records.push({
        number: r.number,
        airline: '長榮航空',
        date: r.date,
        departure,
        arrival,
        arrivalTimeZone: zone,
        airport: r.airport,
        candidateAirport: null,
        destination: airport.city,
        destinationEnglish: airport.name,
        countryCode: airport.countryCode,
        terminal: null,
        arrivalTerminal: null,
        aircraft: null,
        minutes,
        kind: 'collected_eva',
        label: '長榮官方預定班表',
        url: plan.sourceUrl,
        fetchedAt: r.observedAt,
        operatingAirline: '長榮航空',
        operatingNumber: r.number,
        codeshare: false,
        page: null,
      });
    }
    routes.push({
      airport: route.airport,
      label: route.label,
      status: route.status,
      coveredDates: [...covered].sort(),
      missingDates: requested.filter((d) => !covered.has(d)),
      activeMissingDates: activeDates.filter((d) => !covered.has(d)),
      outsideAnnouncedServiceDates: requested.filter(
        (d) => !activeDates.includes(d),
      ),
      serviceFrom: route.serviceFrom ?? null,
      records: route.records.length,
      errors: route.errors,
    });
    console.log(
      JSON.stringify({
        audited: route.airport,
        dates: covered.size,
        records: route.records.length,
      }),
    );
  }
  assert.equal(
    new Set(records.map((r) => `${r.number}|${r.date}|${r.airport}`)).size,
    records.length,
  );
  records.sort(
    (a, b) =>
      a.departure.localeCompare(b.departure) ||
      a.number.localeCompare(b.number),
  );
  const audit = {
    auditedAt: new Date().toISOString(),
    from: plan.from,
    through: plan.through,
    days: requested.length,
    candidateAirports: routes.length,
    completeCandidateAirports: routes.filter((r) => !r.missingDates.length)
      .length,
    servedAirports: routes.filter((r) => r.records).length,
    records: records.length,
    allSelectorDatesObserved: routes.every((r) => !r.missingDates.length),
    allEVAAirRoutesWorldwideComplete: false,
    routes,
  };
  await fs.writeFile(
    path.join(root, 'audit.json'),
    JSON.stringify(audit, null, 2),
  );
  await fs.mkdir('data/cache/eva-yearend', { recursive: true });
  await fs.writeFile(
    'data/cache/eva-yearend/website-candidate.json',
    JSON.stringify({
      version: 1,
      importedAt: audit.auditedAt,
      records,
      coverage: [
        {
          kind: 'collected_eva',
          label: '長榮官方預定班表（桃園直飛）',
          url: plan.sourceUrl,
          fetchedAt:
            records.map((r) => r.fetchedAt).sort()[0] || audit.auditedAt,
          description: `長榮桃園直飛已收集班表：${plan.from}～${plan.through}；${audit.servedAirports} 個目的地。限官網公開班表，非即時動態。`,
          dates: [...new Set(records.map((r) => r.date))].sort(),
          records: records.length,
        },
      ],
    }),
  );
  console.log(JSON.stringify({ ...audit, routes: undefined }));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
