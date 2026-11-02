/** Foreground bounded year-end collection. Durable raw evidence; no challenge bypass. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseTable } from './eva-table-scope.mjs';
const args = process.argv.slice(2),
  opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const python = opt('--python'),
  root = path.resolve(
    opt('--root') || 'data/source-samples/crawler/eva-yearend-2026',
  );
if (!root.startsWith(path.resolve('data/source-samples/crawler') + path.sep))
  throw Error('Research path outside workspace');
const sourceUrl =
  'https://booking.evaair.com/flyeva/eva/b2c/flight-schedules.aspx?lang=en-hk';
const from = opt('--from') || '2026-10-08',
  through = opt('--through') || '2026-12-31';
if (
  !/^2026-\d{2}-\d{2}$/.test(from) ||
  through !== '2026-12-31' ||
  from > through
)
  throw Error('Invalid year-end date scope');
const existing = args.includes('--existing-only')
  ? JSON.parse(
      await fs.readFile('src/server/data/eva-flights.json', 'utf8'),
    ).records.filter((r) => r.date >= from && r.date <= through)
  : null;
if (!python) throw Error('--python required');
await fs.mkdir(root, { recursive: true });
const lock = await fs.open(path.join(root, 'run.lock'), 'wx');
await lock.writeFile(
  JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
);
const json = async (file, v) => {
  await fs.writeFile(
    path.join(root, file) + '.tmp',
    JSON.stringify(v, null, 2),
  );
  await fs.rename(path.join(root, file) + '.tmp', path.join(root, file));
};
const parse = (file) =>
  JSON.parse(
    execFileSync(
      python,
      ['scripts/crawler/fetch-eva-form.py', '--parse-file', file],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 4000000 },
    ),
  );
const cookies = new Map();
let last = 0,
  requests = 0,
  plan;
async function request(url, file, fields) {
  const target = new URL(url);
  if (
    target.origin !== 'https://booking.evaair.com' ||
    ![
      '/flyeva/eva/b2c/flight-schedules.aspx',
      '/flyeva/handler/getairportcache.ashx',
    ].includes(target.pathname.toLowerCase())
  )
    throw Error('Unexpected endpoint');
  await delay(Math.max(0, 1500 - (Date.now() - last)));
  last = Date.now();
  const headers = {
    'User-Agent': 'FlightStatusResearch/0.1 (public timetable collection)',
    Accept: fields ? 'text/html' : '*/*',
  };
  if (cookies.size)
    headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  if (fields) headers.Referer = sourceUrl;
  const start = Date.now();
  const response = await fetch(url, {
    method: fields ? 'POST' : 'GET',
    headers,
    body: fields ? new URLSearchParams(fields) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });
  requests++;
  for (const item of response.headers.getSetCookie()) {
    const p = item.split(';')[0],
      i = p.indexOf('=');
    if (i > 0) cookies.set(p.slice(0, i), p.slice(i + 1));
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > 2000000) throw Error('Response too large');
  await fs.writeFile(path.join(root, file), body);
  const receipt = {
    url,
    method: fields ? 'POST' : 'GET',
    httpStatus: response.status,
    location: response.headers.get('location'),
    observedAt: new Date().toISOString(),
    bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    elapsedMs: Date.now() - start,
    file,
  };
  await fs.writeFile(
    path.join(root, file + '.receipt.json'),
    JSON.stringify(receipt, null, 2),
  );
  if (response.status !== 200)
    throw Error(
      `HTTP ${response.status}; collection stopped, no redirects followed`,
    );
  return receipt;
}
const days = [];
for (let d = Date.parse(from); d <= Date.parse(through); d += 86400000)
  days.push(new Date(d).toISOString().slice(0, 10));
try {
  try {
    plan = JSON.parse(
      await fs.readFile(path.join(root, 'progress.json'), 'utf8'),
    );
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    await request(
      'https://booking.evaair.com/FLYEVA/handler/getAirportCache.ashx?action=01',
      'airports.xml',
    );
    const catalog = JSON.parse(
      execFileSync(
        python,
        [
          'scripts/crawler/fetch-eva-form.py',
          '--parse-airports-file',
          path.join(root, 'airports.xml'),
        ],
        { encoding: 'utf8' },
      ),
    ).airports;
    plan = {
      version: 1,
      from,
      through,
      sourceUrl,
      scope:
        'TPE direct passenger flights operated by EVA AIR; official public timetable',
      startedAt: new Date().toISOString(),
      integratedIntoWebsite: false,
      scopeMode: existing
        ? 'recheck_existing_airports_and_saved_dates'
        : 'full_published_scope',
      routes: catalog
        .filter(
          (r) =>
            !['TPETPE', 'TPETSA', 'KHHKHH', 'RMQRMQ', 'OSAOSA'].includes(
              r.value,
            ) &&
            (!existing ||
              existing.some((f) => f.airport === r.value.slice(-3))),
        )
        .map((r) => ({
          ...r,
          airport: r.value.slice(-3),
          observations: [],
          errors: [],
          records: [],
          status: 'pending',
          ...(existing && {
            savedDates: [
              ...new Set(
                existing
                  .filter((f) => f.airport === r.value.slice(-3))
                  .map((f) => f.date),
              ),
            ].sort(),
          }),
        })),
    };
    await json('progress.json', plan);
  }
  if (plan.from !== from || plan.through !== through)
    throw Error('Saved date scope differs; do not reuse another run');
  if (plan.stopped)
    throw Error('Source already stopped in this run; no repeat');
  let serviceStarts = [];
  try {
    serviceStarts = JSON.parse(
      await fs.readFile(path.join(root, 'service-starts.json'), 'utf8'),
    );
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const evidence of serviceStarts) {
    if (
      evidence.airport !== 'DEL' ||
      evidence.serviceFrom !== '2026-12-01' ||
      path.basename(evidence.file) !== evidence.file
    )
      throw Error('Unreviewed service-start evidence');
    const raw = await fs.readFile(path.join(root, evidence.file));
    if (createHash('sha256').update(raw).digest('hex') !== evidence.sha256)
      throw Error('Changed launch announcement');
    const route = plan.routes.find((r) => r.airport === evidence.airport);
    route.serviceFrom = evidence.serviceFrom;
    route.serviceStartEvidence = evidence;
  }
  const wanted = args.includes('--airport') ? opt('--airport') : null;
  const max = args.includes('--max-tables')
    ? Number(opt('--max-tables'))
    : 1500;
  let tables = 0;
  for (const route of plan.routes) {
    if (wanted && route.airport !== wanted) continue;
    const activeDays = days.filter(
      (d) =>
        (!route.serviceFrom || d >= route.serviceFrom) &&
        (!route.savedDates || route.savedDates.includes(d)),
    );
    const covered = new Set(
      route.observations.filter((o) => o.validated).flatMap((o) => o.dates),
    );
    if (activeDays.every((d) => covered.has(d))) continue;
    console.log(
      JSON.stringify({
        route: route.airport,
        covered: covered.size,
        remaining: activeDays.filter((d) => !covered.has(d)).length,
      }),
    );
    const prefix = `${route.airport}-${route.observations.length}-${Date.now()}`;
    await request(sourceUrl, `${prefix}-form.html`);
    let page = parse(path.join(root, `${prefix}-form.html`));
    const bounds = page.inputs.content_txt_tbGo2YYYYMM;
    if (
      !bounds?.min ||
      !bounds?.max ||
      bounds.min > from ||
      bounds.max < through
    )
      throw Error('Requested dates outside current published bounds');
    const unavailableProbes = new Set(
      args.includes('--probe-unavailable')
        ? (route.unavailableQueries ?? []).flatMap((q) => q.probeDates)
        : [],
    );
    while (tables < max) {
      const remaining = activeDays.filter(
        (d) => !covered.has(d) && !unavailableProbes.has(d),
      );
      if (!remaining.length) break;
      const group = remaining.slice(0, 7),
        date = group[Math.floor(group.length / 2)];
      const file = `${route.airport}-${date}-${Date.now()}.html`;
      const fields = { ...page.fields };
      const changes = {
        ctl00$__MasterEVENTTARGET: 'ctl00$content$btn_ok',
        ctl00$__MasterEVENTARGUMENT: '',
        ctl00$content$rbn_Segment1: 'ONE_WAY',
        ctl00$content$hid_Dep: 'TPETPE',
        ctl00$content$hid_Arr: route.value,
        ctl00$content$txt_formcity: 'TPETPE',
        ctl00$content$txt_tocity: route.value,
        ctl00$content$txt_tbGoYYYYMM: date,
        ctl00$content$txt_tbGo2YYYYMM: date,
      };
      if (
        !page.action ||
        Object.keys(changes).some((k) => !Object.hasOwn(fields, k))
      )
        throw Error('Unreviewed form structure');
      const receipt = await request(
        new URL(page.action, sourceUrl).href,
        file,
        { ...fields, ...changes },
      );
      tables++;
      page = parse(path.join(root, file));
      try {
        const body = await fs.readFile(path.join(root, file), 'utf8');
        if (
          !page.rows.length &&
          body.includes(
            'We are sorry that the flight information you inquire is not available yet.',
          )
        ) {
          route.unavailableQueries ??= [];
          route.unavailableQueries.push({
            queryDate: date,
            probeDates: group,
            file,
            observedAt: receipt.observedAt,
            meaning:
              'source_not_available; not proof of no flights or verified date coverage',
          });
          if (args.includes('--probe-unavailable')) {
            group.forEach((d) => unavailableProbes.add(d));
            route.status = 'source_unavailable_or_partial';
            await json('progress.json', plan);
            console.log(
              JSON.stringify({ unavailable: route.airport, queryDate: date }),
            );
            continue;
          }
          throw Error(
            'Official source says flight information is not available yet',
          );
        }
        if (
          !/<img[^>]+src="https:\/\/booking\.evaair\.com\/flyeva\/content\/images\/b2c\/icon_rwd\/BR\.png"[^>]+alt="EVA AIR"/.test(
            body,
          )
        )
          throw Error('Missing official EVA operator legend');
        const result = parseTable(page.rows, route.airport, sourceUrl);
        if (
          route.serviceFrom &&
          result.records.some((r) => r.date < route.serviceFrom)
        )
          throw Error('Table contradicts published launch date');
        const scope = result.dates.filter(
          (d) =>
            days.includes(d) && (!route.serviceFrom || d >= route.serviceFrom),
        );
        for (const through of result.throughRecords.filter((r) =>
          scope.includes(r.date),
        )) {
          const firstLeg = plan.routes
            .find((r) => r.airport === 'BKK')
            .records.find(
              (r) =>
                r.number === through.number &&
                r.date === through.date &&
                r.departureTime === through.departureTime,
            );
          if (!firstLeg)
            throw Error(
              'Missing matching TPE-BKK first leg for through service',
            );
        }
        if (!scope.some((d) => !covered.has(d)))
          throw Error('Returned date window makes no progress');
        const observation = {
          queryDate: date,
          file,
          observedAt: receipt.observedAt,
          dates: scope,
          validated: false,
          excluded: result.excluded,
          throughRecords: result.throughRecords.filter((r) =>
            scope.includes(r.date),
          ),
        };
        route.observations.push(observation);
        if (!result.completeDirectTable)
          throw Error('Unreviewed or connecting row; raw evidence saved');
        for (const r of result.records.filter((r) => scope.includes(r.date))) {
          const existing = route.records.find(
            (x) => x.number === r.number && x.date === r.date,
          );
          if (
            existing &&
            JSON.stringify([
              existing.departureTime,
              existing.arrivalTime,
              existing.arrivalDayOffset,
            ]) !==
              JSON.stringify([
                r.departureTime,
                r.arrivalTime,
                r.arrivalDayOffset,
              ])
          )
            throw Error('Overlapping table conflict');
          if (!existing)
            route.records.push({
              ...r,
              observedAt: receipt.observedAt,
              sourceUrl,
              evidenceFile: file,
            });
        }
        observation.validated = true;
        for (const d of scope) covered.add(d);
        route.status = activeDays.every((d) => covered.has(d))
          ? route.serviceFrom
            ? 'complete_published_service_scope'
            : 'complete_observed_direct_tables'
          : 'collecting';
        console.log(
          JSON.stringify({
            airport: route.airport,
            through: scope.at(-1),
            days: covered.size,
            records: route.records.length,
          }),
        );
      } catch (e) {
        route.errors.push({
          queryDate: date,
          file,
          error: e.message,
          at: new Date().toISOString(),
        });
        route.status = 'needs_review';
        console.log(
          JSON.stringify({ review: route.airport, date, error: e.message }),
        );
        await json('progress.json', plan);
        break;
      }
      await json('progress.json', plan);
    }
    await json('progress.json', plan);
    if (tables >= max) break;
  }
  plan.finishedAt = new Date().toISOString();
  await json('progress.json', plan);
  const summary = {
    from,
    through,
    days: days.length,
    candidateAirports: plan.routes.length,
    completedAirports: plan.routes.filter(
      (r) => r.status === 'complete_observed_direct_tables',
    ).length,
    records: plan.routes.reduce((n, r) => n + r.records.length, 0),
    review: plan.routes
      .filter((r) => r.status === 'needs_review')
      .map((r) => ({ airport: r.airport, errors: r.errors })),
    requestsThisRun: requests,
    allComplete: plan.routes.every(
      (r) => r.status === 'complete_observed_direct_tables',
    ),
    integratedIntoWebsite: false,
  };
  await json('summary.json', summary);
  console.log(JSON.stringify(summary));
} catch (e) {
  if (plan) {
    plan.stopped = {
      at: new Date().toISOString(),
      reason: e.message,
      cause: e.cause?.message,
    };
    await json('progress.json', plan);
  }
  throw e;
} finally {
  await lock.close();
  await fs.unlink(path.join(root, 'run.lock'));
}
