/** Resumable public timetable collection; never changes website catalogues or ledger. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchPublicSession } from '../automatic-verification/public-session';
import { taipeiDate } from '../../src/lib/time';
const root = 'data/source-samples/crawler/khh-jeju-20261016';
const samples = 'data/source-samples/crawler/khh-airline-research-20261016';
const FROM = '2026-10-16',
  THROUGH = '2026-12-31';
const day = (d: string, n: number) =>
  new Date(Date.parse(d + 'T00:00Z') + n * 86400000).toISOString().slice(0, 10);
const read = async (p: string) =>
  JSON.parse((await fs.readFile(p, 'utf8')).replace(/^\uFEFF/, ''));
const exists = async (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const atomic = async (p: string, v: unknown) => {
  const tmp = p + '.' + randomUUID() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(v, null, 2) + '\n', { flag: 'wx' });
  await fs.rename(tmp, p);
};
const dates: string[] = [];
for (let date = FROM; date <= THROUGH; date = day(date, 1)) dates.push(date);
const records = new Map<string, any>(),
  coverage = new Map<string, any>();
const responses: any[] = [],
  conflicts: any[] = [];
let routes: string[] = ['GMP', 'PUS'],
  requests = 0,
  sessionReady = false;
const jar = new Map<string, string>();
const endpoint =
  'https://www.jejuair.net/en/prepare/flight/getFlightSchedule.json';
let originals: Record<string, string>;
async function checkpoint(state: string, reason?: string) {
  await atomic(root + '/candidate-flights.json', {
    version: 1,
    researchOnly: true,
    integratedIntoWebsite: false,
    scope: { origin: 'KHH', from: FROM, through: THROUGH },
    records: [...records.values()].sort(
      (a, b) =>
        a.departure.localeCompare(b.departure) ||
        a.number.localeCompare(b.number),
    ),
  });
  await atomic(root + '/progress.json', {
    version: 1,
    state,
    reason,
    savedAt: new Date().toISOString(),
    scope: { origin: 'KHH', from: FROM, through: THROUGH },
    routes,
    requiredCells: dates.length * routes.length,
    coveredCells: coverage.size,
    uncovered: routes.flatMap((airport) =>
      dates
        .filter((date) => !coverage.has(`${airport}|${date}`))
        .map((date) => ({ airport, date })),
    ),
    records: records.size,
    sourceResponses: responses,
    coverage: [...coverage.values()],
    conflicts,
    catalogueHashes: originals,
    websiteModified: false,
    ledgerModified: false,
    requestsThisExecution: requests,
  });
}
async function stopped(host: string) {
  const daily = `data/automatic-verification/source-stops/${taipeiDate()}.json`;
  if (await exists(daily)) {
    const stops = await read(daily);
    if (stops[host]) throw new Error(`Daily source stop retained: ${host}`);
  }
  if (await exists(root + '/source-stops.json'))
    throw new Error('Research source stop retained; no repeat');
}
async function download(
  id: string,
  url: string,
  body?: Record<string, string>,
) {
  const stem = root + '/' + id;
  if (await exists(stem + '.receipt.json')) {
    const receipt = await read(stem + '.receipt.json');
    assert.equal(receipt.url, url);
    assert.equal(receipt.status, 200);
    const bytes = await fs.readFile(stem + '.body');
    assert.equal(digest(bytes), receipt.sha256);
    return { bytes, receipt, file: stem + '.body' };
  }
  await stopped(new URL(url).host);
  assert.ok(
    !(await exists(stem + '.started.json')),
    'Interrupted request retained, no automatic repeat',
  );
  assert.equal(
    taipeiDate(),
    FROM,
    'Only the reviewed collection date is authorized by this saved plan',
  );
  await fs.writeFile(
    stem + '.started.json',
    JSON.stringify({
      url,
      body,
      method: body ? 'POST' : 'GET',
      startedAt: new Date().toISOString(),
    }),
    { flag: 'wx' },
  );
  try {
    requests++;
    const response = await fetchPublicSession(
      url,
      body
        ? {
            method: 'POST',
            body: new URLSearchParams(body),
            headers: { tcode: '0000000466', cname: 'PC' },
          }
        : {},
      jar,
      async (response, hop) => {
        await response.body?.cancel();
        await fs.writeFile(
          `${stem}.redirect-${hop}.json`,
          JSON.stringify({
            status: response.status,
            location: response.headers.get('location'),
            anonymousSession: true,
          }),
          { flag: 'wx' },
        );
      },
    );
    const chunks: Uint8Array[] = [];
    let size = 0;
    assert.ok(response.body, 'Missing response body');
    const reader = response.body.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        assert.ok(size < 10000000, 'Source size limit');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = Buffer.concat(chunks);
    await fs.writeFile(stem + '.body', bytes, { flag: 'wx' });
    const receipt = {
      url,
      status: response.status,
      fetchedAt: new Date().toISOString(),
      sha256: digest(bytes),
      bytes: size,
      authenticated: false,
      cookiesPersisted: false,
    };
    await fs.writeFile(
      stem + '.receipt.json',
      JSON.stringify(receipt, null, 2),
      { flag: 'wx' },
    );
    assert.equal(response.status, 200, 'Source HTTP refusal or redirect; stop');
    assert.ok(
      !/access denied|verify you are human|<title>[^<]*(captcha|just a moment)|Request unsuccessful\.\s*Incapsula/i.test(
        bytes.toString(),
      ),
      'Source challenge; stop',
    );
    return { bytes, receipt, file: stem + '.body' };
  } catch (error) {
    await atomic(root + '/source-stops.json', {
      host: new URL(url).host,
      at: new Date().toISOString(),
      reason: String(error),
      evidence: stem,
    });
    throw error;
  }
}
async function consume(file: string, date: string, airport: string) {
  const receipt = await read(file.replace(/\.body$/, '.receipt.json'));
  const bytes = await fs.readFile(file);
  assert.equal(digest(bytes), receipt.sha256);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.url, endpoint);
  assert.equal(taipeiDate(new Date(receipt.fetchedAt)), FROM);
  const payload = JSON.parse(bytes.toString());
  assert.equal(payload.code, '0000');
  assert.ok(Array.isArray(payload.data?.dep));
  const start = day(date, -3),
    end = day(date, 3);
  for (const [index, item] of payload.data.dep.entries()) {
    const d = item.designator,
      leg = item.legDetails,
      identity = item.identifier;
    assert.equal(d.origin, 'KHH');
    assert.equal(d.destination, airport);
    assert.equal(identity.carrierCode, '7C');
    assert.equal(leg.codeShareIndicator, 'NonCodeShare');
    assert.ok(['Normal', 'Closed'].includes(leg.status));
    const departure = d.departure + '+08:00',
      arrival = d.arrival + '+09:00',
      actual = departure.slice(0, 10);
    assert.equal(Date.parse(departure), Date.parse(leg.departureTimeUtc));
    assert.equal(Date.parse(arrival), Date.parse(leg.arrivalTimeUtc));
    assert.ok(actual >= start && actual <= end);
    if (actual < FROM || actual > THROUGH) continue;
    const minutes = (Date.parse(arrival) - Date.parse(departure)) / 60000;
    assert.ok(Number.isInteger(minutes) && minutes > 0 && minutes < 1440);
    const row = {
      origin: 'KHH',
      number: '7C' + identity.identifier,
      airline: '濟州航空',
      date: actual,
      departure,
      arrival,
      arrivalTimeZone: 'Asia/Seoul',
      airport,
      candidateAirport: null,
      destination: airport === 'GMP' ? '首爾' : '釜山',
      destinationEnglish: d.destinationName,
      countryCode: 'KR',
      terminal: null,
      arrivalTerminal: null,
      aircraft: null,
      minutes,
      kind: 'collected_jeju',
      label: '濟州航空官方預定班表（高雄出發）',
      url: 'https://www.jejuair.net/en/prepare/flight/viewScheduleInfo.do',
      fetchedAt: receipt.fetchedAt,
      operatingAirline: '濟州航空',
      operatingNumber: null,
      codeshare: false,
      page: null,
      sourceNotice:
        '官方公布預定班表，非即時動態或訂位庫存；未公布的機型、航廈、櫃台與登機門保留未知。',
      sourceScheduleFlag: leg.status,
      evidence: {
        file,
        sha256: receipt.sha256,
        sourceUrl: endpoint,
        rowIndex: index,
        query: { origin: 'KHH', airport, date },
      },
    };
    const key = `${actual}|${row.number}|${airport}`,
      old = records.get(key);
    if (old) {
      if (old.departure !== departure || old.arrival !== arrival)
        conflicts.push({ key, original: old, observation: row });
    } else records.set(key, row);
  }
  // The published weekly response and existing audited provider cover ±3 days,
  // including successful days with zero departures. Never infer daily service.
  for (const actual of dates.filter((d) => d >= start && d <= end)) {
    const key = `${airport}|${actual}`;
    if (!coverage.has(key))
      coverage.set(key, {
        airport,
        date: actual,
        queryDate: date,
        evidenceFile: file,
        flights: payload.data.dep.filter(
          (r: any) => r.designator.departure.slice(0, 10) === actual,
        ).length,
      });
  }
  responses.push({
    airport,
    date,
    file,
    sha256: receipt.sha256,
    fetchedAt: receipt.fetchedAt,
  });
}
async function main() {
  await fs.mkdir(root, { recursive: true });
  const lock = await fs.open(root + '/collect.lock', 'wx');
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  try {
    if (await exists(root + '/protected-hashes.json'))
      originals = await read(root + '/protected-hashes.json');
    else {
      const job = await read(
        'data/automatic-verification/runs/2026-10-16/progress.json',
      );
      originals = job.originals;
      await fs.writeFile(
        root + '/protected-hashes.json',
        JSON.stringify(originals, null, 2),
        { flag: 'wx' },
      );
    }
    for (const [file, hash] of Object.entries(originals))
      assert.equal(digest(await fs.readFile(file)), hash);
    const previous = (await exists(root + '/progress.json'))
      ? await read(root + '/progress.json')
      : null;
    if (previous)
      for (const s of previous.sourceResponses)
        await consume(s.file, s.date, s.airport);
    else
      for (const airport of ['GMP', 'PUS'])
        for (const date of ['2026-10-17', '2026-11-26', '2026-12-31'])
          await consume(
            `${samples}/jeju-${airport.toLowerCase()}-${date}.body`,
            date,
            airport,
          );
    await checkpoint('samples_reused');
    const stationURL =
      'https://sec.jejuair.net/en/ibe/booking/selectArrivalStations.json';
    const station = await download('khh-direct-stations', stationURL, {
      bookType: 'Schedule',
      cultureCode: 'en-US',
      originAirport: 'KHH',
      pageType: 'schedule',
    });
    const inventory = JSON.parse(station.bytes.toString());
    assert.equal(inventory.code, '0000');
    const direct = inventory.data.data.stations.filter(
      (r: any) => r.mac !== 'Y' && r.connectYn === 'N',
    );
    assert.ok(direct.length > 0);
    routes = [
      ...new Set(direct.map((r: any) => r.stationCode)),
    ].sort() as string[];
    assert.deepEqual(
      routes,
      ['GMP', 'PUS'],
      'Unreviewed additional destinations; save inventory before expansion',
    );
    await checkpoint('collecting');
    const deadline = Date.now() + 15 * 60000;
    let batch = 0;
    for (const airport of routes) {
      while (true) {
        const missing = dates.find(
          (date) => !coverage.has(`${airport}|${date}`),
        );
        if (!missing) break;
        if (Date.now() > deadline || batch >= 24) {
          await checkpoint('batch_saved');
          return;
        }
        const queryDate = day(missing, 3) > THROUGH ? THROUGH : day(missing, 3);
        if (!sessionReady) {
          await download(
            'session-' + randomUUID(),
            'https://www.jejuair.net/en/prepare/flight/viewScheduleInfo.do',
          );
          sessionReady = true;
        }
        await delay(800);
        const response = await download(
          `jeju-${airport.toLowerCase()}-${queryDate}`,
          endpoint,
          {
            startDate: queryDate.replaceAll('-', ''),
            endDate: '',
            depStn: 'KHH',
            arrStn: airport,
            cultureCode: 'en-US',
          },
        );
        await consume(response.file, queryDate, airport);
        batch++;
        await checkpoint('collecting');
        console.log(
          JSON.stringify({
            airport,
            queryDate,
            records: records.size,
            coveredCells: coverage.size,
            requiredCells: dates.length * routes.length,
          }),
        );
        assert.equal(
          conflicts.length,
          0,
          'Conflicting published observations saved for review',
        );
      }
    }
    for (const [file, hash] of Object.entries(originals))
      assert.equal(digest(await fs.readFile(file)), hash);
    assert.equal(coverage.size, dates.length * routes.length);
    await checkpoint(
      conflicts.length
        ? 'completed_with_conflicts'
        : 'collected_pending_independent_audit',
    );
  } catch (error) {
    await checkpoint('pending', String(error));
    console.error(String(error));
    process.exitCode = 1;
  } finally {
    await lock.close();
    await fs.unlink(root + '/collect.lock');
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
