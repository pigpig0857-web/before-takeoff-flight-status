// Bounded, resumable public reverse-direction observations. No site writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = 'data/source-samples/crawler/return-world-20261019/starlux';
await fs.mkdir(root, { recursive: true });
const read = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const exists = async (p) =>
  fs.access(p).then(
    () => true,
    () => false,
  );
const save = async (p, v) => {
  await fs.writeFile(p + '.tmp', JSON.stringify(v, null, 2));
  await fs.rename(p + '.tmp', p);
};
const hash = (b) => createHash('sha256').update(b).digest('hex');
const day = (d, n) =>
  new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000)
    .toISOString()
    .slice(0, 10);
const routes = await read(
  'data/source-samples/crawler/additional-airlines-20261013/starlux-tpe-destinations.json',
);
const origins = routes.groups
  .flatMap((g) => g.options.map((o) => o.trim().split(/\s+/)[0]))
  .sort();
const plan = [];
for (let week = '2026-10-19'; week <= '2026-12-31'; week = day(week, 7))
  for (const origin of origins)
    plan.push({ origin, destination: 'TPE', date: day(week, 3), week });
const planFile = path.join(root, 'plan.json');
if (await exists(planFile)) {
  if (JSON.stringify((await read(planFile)).requests) !== JSON.stringify(plan))
    throw Error('Changed plan');
} else
  await fs.writeFile(
    planFile,
    JSON.stringify(
      { from: '2026-10-19', through: '2026-12-31', requests: plan },
      null,
      2,
    ),
    { flag: 'wx' },
  );
const stops = await read(
  'data/automatic-verification/source-stops/2026-10-19.json',
);
if (stops['ecapi.starlux-airlines.com']) throw Error('Source stopped today');
let completed = 0,
  fresh = 0;
for (const cell of plan) {
  const base = path.join(root, cell.origin + '-' + cell.week);
  try {
    let body, receipt;
    if (await exists(base + '.receipt.json')) {
      receipt = await read(base + '.receipt.json');
      body = await fs.readFile(base + '.json');
    } else {
      if (await exists(base + '.started.json'))
        throw Error('Unfinished/failed request; do not retry');
      const url = new URL(
        'https://ecapi.starlux-airlines.com/flightSchedule/v2/timetable',
      );
      url.search = new URLSearchParams({
        depAirport: cell.origin,
        arrAirport: 'TPE',
        date: cell.date,
      }).toString();
      await fs.writeFile(
        base + '.started.json',
        JSON.stringify({ url: url.href, ...cell }),
        { flag: 'wx' },
      );
      const response = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(25000),
        headers: { accept: 'application/json' },
      });
      body = Buffer.from(await response.arrayBuffer());
      if (body.length > 1000000) throw Error('Size limit');
      receipt = {
        url: url.href,
        status: response.status,
        sha256: hash(body),
        fetchedAt: new Date().toISOString(),
        ...cell,
      };
      await fs.writeFile(base + '.json', body, { flag: 'wx' });
      await fs.writeFile(
        base + '.receipt.json',
        JSON.stringify(receipt, null, 2),
        { flag: 'wx' },
      );
      fresh++;
    }
    if (receipt.status !== 200 || receipt.sha256 !== hash(body))
      throw Error('HTTP/source hash failure');
    const data = JSON.parse(body);
    if (
      !data.success ||
      data.message?.code !== '00000' ||
      !Array.isArray(data.data?.timetable)
    )
      throw Error('Incomplete response');
    for (const row of data.data.timetable) {
      if (
        row.depAirport !== cell.origin ||
        row.arrAirport !== 'TPE' ||
        !Array.isArray(row.schedule)
      )
        throw Error('Wrong route');
      if (row.schedule.some((d) => d < cell.week || d > day(cell.week, 6)))
        throw Error('Unexpected date window');
    }
    completed++;
    await save(path.join(root, 'progress.json'), {
      state: 'collecting',
      completed,
      planned: plan.length,
      fresh,
      last: cell,
    });
    if (completed % origins.length === 0)
      console.log(
        JSON.stringify({
          completed,
          planned: plan.length,
          lastWeek: cell.week,
        }),
      );
    if (fresh) await new Promise((r) => setTimeout(r, 600));
  } catch (error) {
    await save(path.join(root, 'progress.json'), {
      state: 'stopped_pending',
      completed,
      planned: plan.length,
      pending: cell,
      error: error.message,
    });
    process.exitCode = 1;
    console.log(error.message);
    break;
  }
}
if (completed === plan.length)
  await save(path.join(root, 'progress.json'), {
    state: 'downloaded',
    completed,
    planned: plan.length,
  });
