/** Audit the current country/date/time search scope without modifying flight snapshots. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  normalizeCollected,
  type SavedFlight,
} from '../src/server/providers/collected';
import { filterFlights } from '../src/features/flights/filter';
import {
  arrivalAirport,
  destinationCountry,
} from '../src/features/flights/destinations';

async function main() {
  const from = '2026-10-12',
    through = '2026-12-31';
  const root = path.resolve(
    'data/source-samples/crawler',
    `basic-search-audit-${Date.now()}`,
  );
  await fs.mkdir(root, { recursive: true });
  const read = async (file: string) =>
    JSON.parse(await fs.readFile(file, 'utf8'));
  const key = (r: any) =>
    `${r.date}|${String(r.number).replace(/^([A-Z0-9]{2})0+(?=\d)/, '$1')}|${r.airport || r.destinationCode}`;
  const selected = (rs: SavedFlight[]) =>
    rs.filter((r) => r.date >= from && r.date <= through);
  const datasets = await Promise.all(
    ['eva', 'peach'].map(async (id) => ({
      id,
      snapshot: await read(`src/server/data/${id}-flights.json`),
    })),
  );
  const records: SavedFlight[] = datasets.flatMap((d) =>
    selected(d.snapshot.records),
  );
  const before = Object.fromEntries(
    await Promise.all(
      [
        'eva-flights',
        'peach-flights',
        'peach-booking-checks',
        'peach-verification-progress',
      ].map(async (id) => [
        id,
        createHash('sha256')
          .update(await fs.readFile(`src/server/data/${id}.json`))
          .digest('hex'),
      ]),
    ),
  );
  const report: any = {
    checkedAt: new Date().toISOString(),
    from,
    through,
    scope:
      'Saved TPE direct departures for EVA and Peach; not all airlines or a new live inventory collection',
    errors: [],
    sources: [],
    websiteCases: [],
    primaryTimeChanges: [],
    extraPrimaryFlights: [],
  };
  const dates = [];
  for (let t = Date.parse(from); t <= Date.parse(through); t += 86400000)
    dates.push(new Date(t).toISOString().slice(0, 10));
  try {
    assert.equal(
      new Set(records.map(key)).size,
      records.length,
      'Duplicate canonical flight identity',
    );
    const normalized = records.map(normalizeCollected);
    for (const r of records) {
      for (const field of [
        'number',
        'airline',
        'date',
        'departure',
        'arrival',
        'airport',
        'countryCode',
        'arrivalTimeZone',
        'operatingAirline',
        'url',
        'fetchedAt',
      ] as const)
        assert.ok(r[field], `${key(r)}:${field}`);
      assert.equal(
        arrivalAirport(r.airport!)?.countryCode,
        r.countryCode,
        `Country mismatch ${key(r)}`,
      );
    }
    for (const d of datasets) {
      const rs = selected(d.snapshot.records);
      const observedDates = new Set(rs.map((r) => r.date));
      assert.ok(
        dates.every((date) => observedDates.has(date)),
        `${d.id}:missing whole departure date`,
      );
      report.sources.push({
        id: d.id,
        records: rs.length,
        dates: observedDates.size,
        airports: new Set(rs.map((r) => r.airport)).size,
        countries: new Set(rs.map((r) => r.countryCode)).size,
        missingRequiredFields: 0,
        duplicates: 0,
        invalidTimesOrZones: 0,
        fetchedAt: [...new Set(rs.map((r) => r.fetchedAt))]
          .sort()
          .filter((_, i, arr) => i === 0 || i === arr.length - 1),
      });
    }
    const codes = [...new Set(records.map((r) => r.countryCode!))].sort();
    let countryCases = 0,
      airportCases = 0;
    for (const date of ['2026-10-24', '2026-10-25', '2026-12-31']) {
      const dateFlights = normalized.filter((f) => f.date === date);
      for (const code of codes) {
        const expected = records
          .filter((r) => r.date === date && r.countryCode === code)
          .map(key)
          .sort();
        for (const q of ['', destinationCountry(code)!.name]) {
          const actual = filterFlights(dateFlights, {
            date,
            q,
            country: q ? '' : code,
            start: '00:00',
            end: '23:59',
            status: '',
          });
          assert.deepEqual(
            actual.map(key).sort(),
            expected,
            `${date}:${code}:${q}`,
          );
          countryCases++;
        }
      }
      for (const airport of new Set(records.map((r) => r.airport!))) {
        const actual = filterFlights(dateFlights, {
          date,
          q: airport,
          start: '00:00',
          end: '23:59',
          status: '',
        });
        assert.deepEqual(
          actual.map(key).sort(),
          records
            .filter((r) => r.date === date && r.airport === airport)
            .map(key)
            .sort(),
          `${date}:${airport}`,
        );
        airportCases++;
      }
    }
    report.offlineCountryCases = countryCases;
    report.offlineAirportCases = airportCases;
    // Saved EVA details and independently preserved timetable observations.
    const evidenceRoot = path.resolve(
      'data/source-samples/crawler/eva-yearend-2026',
    );
    const manifest = await read(
      path.join(evidenceRoot, 'full-details/manifest.json'),
    );
    const evidenceByKey = new Map(manifest.map((r: any) => [key(r), r]));
    let details = 0;
    for (const r of records.filter((r) => r.kind === 'collected_eva')) {
      const entry: any = evidenceByKey.get(key(r));
      assert.equal(entry?.status, 'verified');
      const file = path.resolve(evidenceRoot, entry.evidenceFile);
      assert.ok(file.startsWith(evidenceRoot + path.sep));
      assert.equal(
        createHash('sha256')
          .update(await fs.readFile(file))
          .digest('hex'),
        entry.sha256,
      );
      assert.equal(r.detail?.url, entry.evidence.url);
      assert.equal(r.detail?.fetchedAt, entry.evidence.fetchedAt);
      details++;
    }
    report.evaDetailEvidenceVerified = details;
    const plan = await read(path.join(evidenceRoot, 'progress.json'));
    const planByKey = new Map(
      plan.routes.flatMap((r: any) => r.records).map((r: any) => [key(r), r]),
    );
    for (const r of records.filter((r) => r.kind === 'collected_eva')) {
      const source: any = planByKey.get(key(r));
      assert.ok(source, `Missing timetable observation ${key(r)}`);
      assert.equal(r.departure.slice(11, 16), source.departureTime);
      assert.equal(r.arrival.slice(11, 16), source.arrivalTime);
    }
    const savedCoverage = await read(path.join(evidenceRoot, 'audit.json'));
    report.evaCandidateRoutes = plan.routes.length;
    report.evaUnresolvedCandidateAirports = plan.routes
      .filter((r: any) => r.status === 'source_unavailable_or_partial')
      .map((r: any) => ({
        airport: r.airport,
        records: r.records.length,
        status: r.status,
      }));
    report.evaActiveMissingDates = savedCoverage.routes
      .filter((r: any) => r.records > 0 && r.activeMissingDates.length)
      .map((r: any) => ({ airport: r.airport, dates: r.activeMissingDates }));
    assert.equal(report.evaActiveMissingDates.length, 0);
    report.peachSourceReplay = await read(
      'data/source-samples/crawler/peach-1791788431310/completeness-audit.json',
    );
    assert.equal(report.peachSourceReplay.status, 'passed');
    assert.equal(report.peachSourceReplay.differences.length, 0);
    console.log(
      JSON.stringify({
        phase: 'saved_data_passed',
        records: records.length,
        countryCases,
        airportCases,
        details,
      }),
    );
    async function query(date: string, q = '', start = '00:00', country = '') {
      const params = new URLSearchParams({
        date,
        q,
        start,
        ...(country ? { country } : {}),
      });
      const response = await fetch(
        `http://127.0.0.1:3000/api/flights?${params}`,
        { signal: AbortSignal.timeout(30000) },
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.mode, 'official');
      assert.equal(body.total, body.flights.length);
      return body;
    }
    // Check every day actually served by the running website, including any current airport overrides.
    for (const date of dates) {
      const body = await query(date);
      const actual = new Map(body.flights.map((f: any) => [key(f), f]));
      assert.equal(
        actual.size,
        body.total,
        `${date}:duplicate website identity`,
      );
      const expected = records.filter((r) => r.date === date);
      for (const r of expected) {
        const f: any = actual.get(key(r));
        assert.ok(f, `Missing website flight ${key(r)}`);
        assert.equal(f.date, date);
        const changedPrimary =
          (f.source === 'realtime' || f.source === 'schedule') &&
          Date.parse(f.scheduledDeparture) !== Date.parse(r.departure);
        if (!changedPrimary) {
          assert.equal(f.scheduledArrival, r.arrival, `Arrival ${key(r)}`);
          assert.equal(f.arrivalTimeZone, r.arrivalTimeZone);
          assert.equal(f.durationMinutes, r.minutes);
        } else {
          // An updated official departure cannot inherit old arrival/detail evidence.
          assert.equal(f.collected, undefined);
        }
        if (f.source === 'realtime' || f.source === 'schedule') {
          if (f.scheduledDeparture !== r.departure)
            report.primaryTimeChanges.push({
              identity: key(r),
              saved: r.departure,
              latest: f.scheduledDeparture,
              arrivalUnknown: !f.scheduledArrival,
            });
        } else assert.equal(f.scheduledDeparture, r.departure);
        assert.equal(
          arrivalAirport(f.destinationCode)?.countryCode,
          r.countryCode,
        );
      }
      const expectedKeys = new Set(expected.map(key));
      report.extraPrimaryFlights.push(
        ...body.flights
          .filter((f: any) => !expectedKeys.has(key(f)))
          .map((f: any) => ({ identity: key(f), source: f.source })),
      );
      report.websiteCases.push({
        date,
        type: 'full_day',
        saved: expected.length,
        actual: body.total,
        state: body.resultState,
      });
      if (report.websiteCases.length % 20 === 0)
        console.log(
          JSON.stringify({
            phase: 'website_days',
            checked: report.websiteCases.length,
          }),
        );
    }
    // Exercise product filters against returned website data instead of obsolete fixture counts.
    const day = await query('2026-11-10');
    for (const code of codes) {
      const expected = day.flights
        .filter(
          (f: any) => arrivalAirport(f.destinationCode)?.countryCode === code,
        )
        .map(key)
        .sort();
      for (const [q, country] of [
        [destinationCountry(code)!.name, ''],
        ['', code],
      ]) {
        const body = await query('2026-11-10', q, '00:00', country);
        assert.deepEqual(body.flights.map(key).sort(), expected);
        report.websiteCases.push({
          date: '2026-11-10',
          type: 'country',
          q,
          country,
          flights: body.total,
        });
      }
    }
    const jp = await query('2026-12-31', '日本');
    for (const start of ['00:00', '09:40', '12:00', '13:40', '23:59']) {
      const body = await query('2026-12-31', '日本', start);
      assert.deepEqual(
        body.flights.map(key),
        jp.flights
          .filter((f: any) => f.scheduledDeparture.slice(11, 16) >= start)
          .map(key),
      );
      report.websiteCases.push({
        date: '2026-12-31',
        type: 'time',
        q: '日本',
        start,
        flights: body.total,
      });
    }
    const tokyo = await query('2026-12-31', '日本東京');
    assert.ok(tokyo.flights.some((f: any) => f.destinationCode === 'NRT'));
    assert.ok(tokyo.flights.some((f: any) => f.destinationCode === 'HND'));
    assert.ok(
      tokyo.flights.every((f: any) =>
        ['NRT', 'HND'].includes(f.destinationCode),
      ),
    );
    const haneda = tokyo.flights.find(
      (f: any) => f.airlineCode === 'MM' && f.destinationCode === 'HND',
    );
    assert.equal(haneda.scheduledArrival.slice(0, 10), '2027-01-01');
    report.websiteCases.push({
      date: '2026-12-31',
      type: 'city_and_cross_year',
      q: '日本東京',
      flights: tokyo.total,
      hanedaArrival: haneda.scheduledArrival,
    });
    const outside = await query('2027-01-01', '日本');
    assert.equal(outside.total, 0);
    assert.equal(outside.covered, false);
    assert.equal(outside.resultState, 'outside_coverage');
    report.websiteCases.push({
      date: '2027-01-01',
      type: 'outside_coverage',
      state: outside.resultState,
    });
    const invalid = await fetch(
      'http://127.0.0.1:3000/api/flights?date=2026-02-30',
    );
    assert.equal(invalid.status, 400);
    report.invalidDateRejected = true;
    report.status = 'passed';
  } catch (e) {
    report.status = 'failed';
    report.errors.push(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    report.protectedDataUnchanged = true;
    for (const [id, hash] of Object.entries(before))
      if (
        createHash('sha256')
          .update(await fs.readFile(`src/server/data/${id}.json`))
          .digest('hex') !== hash
      )
        report.protectedDataUnchanged = false;
    assert.ok(report.protectedDataUnchanged);
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(
      path.join(root, 'audit.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log(
      JSON.stringify(
        {
          root,
          status: report.status,
          errors: report.errors,
          sources: report.sources,
          offlineCountryCases: report.offlineCountryCases,
          offlineAirportCases: report.offlineAirportCases,
          websiteCases: report.websiteCases.length,
          unresolvedCandidates: report.evaUnresolvedCandidateAirports,
          protectedDataUnchanged: report.protectedDataUnchanged,
        },
        null,
        2,
      ),
    );
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
