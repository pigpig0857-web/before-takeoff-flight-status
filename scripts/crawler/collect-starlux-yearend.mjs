// Anonymous official weekly timetable reads. Resume saved successes, stop on
// access errors, and never overwrite evidence or change the live catalogue.
import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(
  'data/source-samples/crawler/additional-airlines-20261013',
);
const store = path.join(root, 'starlux-centered');
await mkdir(store, { recursive: true });
const hash = (b) => createHash('sha256').update(b).digest('hex');
const exists = async (p) =>
  access(p).then(
    () => true,
    () => false,
  );
const load = async (p) => JSON.parse(await readFile(p, 'utf8'));
const writeOnce = (p, value) =>
  writeFile(p, JSON.stringify(value, null, 2), { flag: 'wx' });
const from = '2026-10-13',
  through = '2026-12-31';
const day = (d, n) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000)
    .toISOString()
    .slice(0, 10);
const monday = (d) =>
  day(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
const routes = await load(path.join(root, 'starlux-tpe-destinations.json'));
if (routes.origin !== 'TPE') throw new Error('Unreviewed origin');
const destinations = routes.groups
  .flatMap((g) =>
    g.options.map((o) => {
      const code = o.trim().split(/\s+/)[0];
      if (!/^[A-Z]{3}$/.test(code)) throw new Error('Invalid menu airport');
      return code;
    }),
  )
  .sort();
if (
  destinations.length !== new Set(destinations).size ||
  destinations.length !== 33
)
  throw new Error('Unexpected route inventory');
const plan = [];
for (let week = monday(from); week <= through; week = day(week, 7))
  // The official endpoint returns the selected date +/-3 days, not its ISO week.
  // Thursday is the centre of a Monday-Sunday interval. The first failed
  // interpretation is preserved in starlux/ and is never retried/overwritten.
  for (const destination of destinations)
    plan.push({ week, date: day(week, 3), destination });
const planFile = path.join(store, 'plan.json');
if (!(await exists(planFile))) {
  const protectedHashes = Object.fromEntries(
    await Promise.all(
      [
        'eva-flights.json',
        'peach-flights.json',
        'peach-booking-checks.json',
        'peach-verification-progress.json',
        'collected-flights.json',
      ].map(async (n) => [
        n,
        hash(await readFile(path.resolve('src/server/data', n))),
      ]),
    ),
  );
  await writeOnce(planFile, {
    from,
    through,
    origin: 'TPE',
    destinations,
    requests: plan,
    protectedHashes,
    scopeHash: hash(await readFile('src/features/flights/airline-scope.ts')),
    importedIntoWebsite: false,
  });
} else if (
  JSON.stringify((await load(planFile)).requests) !== JSON.stringify(plan)
)
  throw new Error('Saved scope differs');
const reused = {
  'NRT-2026-11-23': 'starlux-api-nrt-1126',
  'DPS-2026-11-23': 'starlux-api-dps-1126',
  'PHX-2026-12-28': 'starlux-api-phx-1231',
  'PRG-2026-12-28': 'starlux-api-prg-1231',
};
const checkpoint = async (value) => {
  const tmp = path.join(store, 'progress.tmp');
  await writeFile(
    tmp,
    JSON.stringify(
      {
        ...value,
        savedAt: new Date().toISOString(),
        importedIntoWebsite: false,
      },
      null,
      2,
    ),
  );
  await rename(tmp, path.join(store, 'progress.json'));
};
const validate = (json, cell) => {
  if (
    json.success !== true ||
    json.message?.code !== '00000' ||
    !Array.isArray(json.data?.timetable)
  )
    throw new Error('Unexpected success/schema');
  for (const row of json.data.timetable) {
    if (
      row.depAirport !== 'TPE' ||
      row.arrAirport !== cell.destination ||
      !Array.isArray(row.schedule)
    )
      throw new Error('Query/result mismatch');
    for (const date of row.schedule)
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        date < cell.week ||
        date > day(cell.week, 6)
      )
        throw new Error('Unexpected calendar window');
  }
};
let completed = 0,
  fresh = 0,
  resumed = 0,
  reusedCount = 0;
await checkpoint({ state: 'collecting', planned: plan.length, completed });
for (const cell of plan) {
  const key = `${cell.destination}-${cell.week}`;
  const receiptFile = path.join(store, `${key}.receipt.json`);
  const bodyFile = path.join(store, `${key}.json`);
  const startFile = path.join(store, `${key}.started.json`);
  try {
    if (await exists(receiptFile)) {
      const receipt = await load(receiptFile),
        body = await readFile(bodyFile);
      if (receipt.status !== 200 || receipt.sha256 !== hash(body))
        throw new Error('Prior failed or corrupt observation; requires review');
      validate(JSON.parse(body), cell);
      resumed++;
    } else {
      if (await exists(startFile))
        throw new Error('Unfinished prior request; requires review, no retry');
      const url = new URL(
        'https://ecapi.starlux-airlines.com/flightSchedule/v2/timetable',
      );
      url.search = new URLSearchParams({
        depAirport: 'TPE',
        arrAirport: cell.destination,
        date: cell.date,
      }).toString();
      await writeOnce(startFile, {
        ...cell,
        url: url.href,
        startedAt: new Date().toISOString(),
      });
      let body, receipt;
      if (reused[key]) {
        body = await readFile(path.join(root, `${reused[key]}.body`));
        receipt = await load(path.join(root, `${reused[key]}.receipt.json`));
        if (receipt.status !== 200 || receipt.sha256 !== hash(body))
          throw new Error('Sample receipt mismatch');
        receipt = {
          ...receipt,
          reusedEvidence: reused[key],
          requestedCell: cell,
        };
        reusedCount++;
      } else {
        const response = await fetch(url, {
          redirect: 'error',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(30000),
        });
        body = Buffer.from(await response.arrayBuffer());
        if (body.length > 1_000_000) throw new Error('Response size limit');
        receipt = {
          ...cell,
          url: url.href,
          status: response.status,
          fetchedAt: new Date().toISOString(),
          bytes: body.length,
          sha256: hash(body),
          authenticated: false,
        };
        fresh++;
      }
      await writeFile(bodyFile, body, { flag: 'wx' });
      await writeOnce(receiptFile, receipt);
      if (receipt.status !== 200)
        throw new Error(`HTTP ${receipt.status}; stop without retry`);
      validate(JSON.parse(body), cell);
      // One request at a time, with a pause between fresh observations.
      if (!reused[key])
        await new Promise((resolve) => setTimeout(resolve, 600));
    }
    completed++;
    await checkpoint({
      state: 'collecting',
      planned: plan.length,
      completed,
      fresh,
      resumed,
      reused: reusedCount,
      last: key,
    });
    if (completed % 33 === 0)
      console.log(
        JSON.stringify({
          week: cell.week,
          completed,
          planned: plan.length,
          fresh,
          resumed,
          reused: reusedCount,
        }),
      );
  } catch (error) {
    const failure = {
      state: 'stopped_pending_review',
      planned: plan.length,
      completed,
      fresh,
      resumed,
      reused: reusedCount,
      pendingCell: cell,
      message: error.message,
    };
    await checkpoint(failure);
    await writeOnce(path.join(store, `${key}.pending.json`), failure);
    throw error;
  }
}
await checkpoint({
  state: 'raw_collection_complete',
  planned: plan.length,
  completed,
  fresh,
  resumed,
  reused: reusedCount,
  validation:
    'Raw identity/date-window checks passed; detailed offline verification pending',
});
console.log(
  JSON.stringify({
    state: 'raw_collection_complete',
    completed,
    fresh,
    resumed,
    reused: reusedCount,
  }),
);
