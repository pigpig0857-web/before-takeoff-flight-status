import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const root = 'data/source-samples/crawler/return-world-20261019';
const log = 'data/flight-updates/world-return-integration-20261019';
const target = 'src/server/data/return-flights.json';
const sha = (body) => createHash('sha256').update(body).digest('hex');
const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const identity = (r) =>
  `${r.date}|${r.airlineCode}|${r.number}|${r.departureAirport}|${r.arrivalAirport}`;
const progress = await read(`${root}/staging/progress.json`);
assert.equal(progress.records, 6998);
assert.equal(progress.conflicts, 0);
for (const source of ['JX', '7C', 'VN', 'PR-latest', 'GK-latest', 'KIX']) {
  assert.equal(
    (await read(`${root}/verified/${source}/independent-audit.json`)).status,
    'passed',
  );
}
const records = [];
for (const month of ['2026-10', '2026-11', '2026-12']) {
  const bytes = await fs.readFile(`${root}/staging/flights-${month}.json`);
  const checkpoint = await read(`${root}/staging/checkpoint-${month}.json`);
  assert.equal(sha(bytes), checkpoint.sha256);
  const batch = JSON.parse(bytes).records;
  assert.equal(batch.length, checkpoint.records);
  records.push(...batch);
}
assert.equal(records.length, 6998);
const byId = new Map(records.map((r) => [identity(r), r]));
assert.equal(byId.size, records.length);
assert.ok(
  !records.some(
    (r) =>
      r.airlineCode === 'NU' ||
      (r.date === '2026-10-22' && r.number === 'IT707'),
  ),
);
const baseline = await read(`${root}/website-before.json`);
for (const [file, hash] of Object.entries(baseline)) {
  if (file !== 'return-flights.json')
    assert.equal(sha(await fs.readFile(`src/server/data/${file}`)), hash, file);
}
const body =
  JSON.stringify(
    {
      version: 2,
      from: progress.fromDate,
      through: progress.through,
      dateBasis: 'departure local date at overseas origin',
      partial: true,
      provenance: `${root}/staging/progress.json`,
      records,
    },
    null,
    2,
  ) + '\n';
const current = await fs.readFile(target);
await fs.mkdir(log, { recursive: true });
if (sha(current) !== sha(body)) {
  assert.equal(
    sha(current),
    baseline['return-flights.json'],
    'Unexpected existing snapshot; review before replacing',
  );
  const prior = JSON.parse(current);
  assert.equal(prior.records.length, 2967);
  for (const r of prior.records)
    assert.deepEqual(
      byId.get(identity(r)),
      r,
      `Changed existing record ${identity(r)}`,
    );
  try {
    await fs.writeFile(`${log}/before.json`, current, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert.equal(sha(await fs.readFile(`${log}/before.json`)), sha(current));
  }
  await fs.writeFile(`${target}.tmp`, body);
  await fs.rename(`${target}.tmp`, target);
}
assert.equal(sha(await fs.readFile(target)), sha(body));
await fs.writeFile(
  `${log}/import.json`,
  JSON.stringify(
    {
      state: 'imported',
      target,
      records: 6998,
      previousRecords: 2967,
      newRecords: 4031,
      preservedRecords: 2967,
      sha256: sha(body),
      previousSha256: baseline['return-flights.json'],
      byAirline: progress.byAirline,
      countries: progress.countries,
      partial: true,
      sourceProgress: `${root}/staging/progress.json`,
      excluded: [
        '143 historical NU records pending fresh confirmation',
        '2026-10-22 IT707 duration mismatch',
      ],
      importedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n',
);
console.log(
  'Imported 6998 unique returns; all 2967 existing records preserved; 17 other data files unchanged.',
);
