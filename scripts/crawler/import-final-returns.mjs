import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root = 'data/source-samples/crawler/return-final-20261020';
const log = 'data/flight-updates/return-integration-20261020';
const target = 'src/server/data/return-flights.json';
const read = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const identity = (r) =>
  [r.date, r.airlineCode, r.number, r.departureAirport, r.arrivalAirport].join(
    '|',
  );
const progress = await read(root + '/staging/progress.json');
assert.equal(progress.records, 12306);
const rows = [];
for (const month of ['2026-10', '2026-11', '2026-12']) {
  const bytes = await fs.readFile(`${root}/staging/flights-${month}.json`),
    checkpoint = await read(`${root}/staging/checkpoint-${month}.json`);
  assert.equal(sha(bytes), checkpoint.sha256);
  const batch = JSON.parse(bytes).records;
  assert.equal(batch.length, checkpoint.records);
  rows.push(...batch);
}
const keys = new Map(rows.map((r) => [identity(r), r]));
assert.equal(keys.size, 12306);
const pending = await read(root + '/staging/pending.json');
assert.equal(pending.length, 32);
for (const p of pending)
  assert.ok(!rows.some((r) => r.date === p.date && r.number === p.number));
const baseline = await read(
  'data/source-samples/crawler/return-gaps-20261020/website-before.json',
);
for (const [file, hash] of Object.entries(baseline))
  if (file !== 'return-flights.json')
    assert.equal(sha(await fs.readFile('src/server/data/' + file)), hash);
const body =
  JSON.stringify(
    {
      version: 3,
      from: '2026-10-19',
      through: '2026-12-31',
      dateBasis: 'departure local date at overseas origin',
      partial: true,
      pendingCount: 32,
      provenance: root + '/staging/progress.json',
      records: rows,
    },
    null,
    2,
  ) + '\n';
const current = await fs.readFile(target);
if (sha(current) !== sha(body)) {
  assert.equal(
    sha(current),
    baseline['return-flights.json'],
    'Unexpected existing data',
  );
  const old = JSON.parse(current);
  assert.equal(old.records.length, 6998);
  for (const r of old.records) assert.deepEqual(keys.get(identity(r)), r);
}
if (!process.argv.includes('--apply')) {
  console.log(
    JSON.stringify({
      state: 'dry_run_passed',
      records: rows.length,
      preserved: 6998,
      newRecords: 5308,
      pendingExcluded: 32,
      websiteModified: false,
    }),
  );
  process.exit(0);
}
await fs.mkdir(log, { recursive: true });
if (sha(current) !== sha(body)) {
  try {
    await fs.writeFile(log + '/before.json', current, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert.equal(sha(await fs.readFile(log + '/before.json')), sha(current));
  }
  await fs.writeFile(target + '.tmp', body);
  await fs.rename(target + '.tmp', target);
}
assert.equal(sha(await fs.readFile(target)), sha(body));
const receipt = {
  state: 'imported',
  records: 12306,
  newRecords: 5308,
  preserved: 6998,
  pendingExcluded: 32,
  sha256: sha(body),
  previousSha256: baseline['return-flights.json'],
  target,
  sourceProgress: root + '/staging/progress.json',
  importedAt: new Date().toISOString(),
};
await fs.writeFile(log + '/import.json', JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
