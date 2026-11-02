import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const checksRaw = await fs.readFile(
  'src/server/data/peach-booking-checks.json',
  'utf8',
);
const checks = JSON.parse(checksRaw);
const progress = JSON.parse(
  await fs.readFile('src/server/data/peach-verification-progress.json', 'utf8'),
);
const snapshot = JSON.parse(
  await fs.readFile('src/server/data/peach-flights.json', 'utf8'),
);
const key = (r) => `${r.date}|${r.airport}|${r.number}`;
const done = new Set(checks.records.map(key));
if (
  done.size !== checks.records.length ||
  progress.records.filter((r) => r.state === 'verified').length !== done.size
)
  throw new Error('Saved completed checks and progress disagree');
const groups = new Map();
for (const record of progress.records.filter((r) => r.state !== 'verified')) {
  if (done.has(key(record)))
    throw new Error('Attempted to queue an already verified flight');
  const source = snapshot.records.find((r) => key(r) === key(record));
  if (!source) throw new Error('Progress missing schedule identity');
  const groupKey = `${record.date}|${record.airport}`;
  const group = groups.get(groupKey) || {
    date: record.date,
    airport: record.airport,
    flights: [],
    retry: false,
  };
  group.flights.push({
    number: record.number,
    state: record.state,
    departure: source.departure,
    arrival: source.arrival,
  });
  if (record.state === 'query_failed') group.retry = true;
  groups.set(groupKey, group);
}
const interrupted = [...groups.values()]
  .filter((q) => q.retry)
  .sort((a, b) => a.date.localeCompare(b.date))[0];
const queue = [...groups.values()].sort((a, b) => {
  const rank = (q) =>
    q === interrupted
      ? 0
      : q.airport === interrupted?.airport && q.date > interrupted.date
        ? 1
        : 2;
  return (
    rank(a) - rank(b) ||
    a.airport.localeCompare(b.airport) ||
    a.date.localeCompare(b.date)
  );
});
const root = path.resolve(
  'data/source-samples/crawler',
  `peach-resume-${Date.now()}`,
);
await fs.mkdir(root, { recursive: true });
const plan = {
  version: 1,
  createdAt: new Date().toISOString(),
  initialCompleted: checks.records.length,
  completedRecords: checks.records,
  completedFileSha256: createHash('sha256').update(checksRaw).digest('hex'),
  initialSummary: progress.summary,
  queuedQueries: queue.length,
  queue,
};
await fs.writeFile(
  path.join(root, 'resume-plan.json'),
  JSON.stringify(plan, null, 2),
);
await fs.writeFile(path.join(root, 'booking-checks.json'), '[]\n', {
  flag: 'wx',
});
await fs.writeFile(path.join(root, 'query-failures.json'), '[]\n', {
  flag: 'wx',
});
await fs.writeFile(
  path.join(root, 'run-status.json'),
  JSON.stringify(
    { state: 'ready', next: queue[0], completedQueries: 0 },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      root,
      initialCompleted: plan.initialCompleted,
      queuedQueries: queue.length,
      next: queue[0],
    },
    null,
    2,
  ),
);
