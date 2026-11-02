import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const root = 'data/source-samples/crawler/return-expansion-20261019';
const staging = path.join(root, 'staging');
const progress = JSON.parse(
  await fs.readFile(path.join(staging, 'progress.json'), 'utf8'),
);
assert.equal(progress.records, 2967);
const sha = (body) => createHash('sha256').update(body).digest('hex');
const records = [];
for (const month of ['2026-10', '2026-11', '2026-12']) {
  const body = await fs.readFile(path.join(staging, `flights-${month}.json`));
  const checkpoint = JSON.parse(
    await fs.readFile(path.join(staging, `checkpoint-${month}.json`), 'utf8'),
  );
  assert.equal(sha(body), checkpoint.sha256);
  const batch = JSON.parse(body).records;
  assert.equal(batch.length, checkpoint.records);
  records.push(...batch);
}
const identities = new Set(
  records.map(
    (r) =>
      `${r.date}|${r.airlineCode}|${r.number}|${r.departureAirport}|${r.arrivalAirport}`,
  ),
);
assert.equal(identities.size, 2967);
assert.ok(
  !records.some((r) => r.date === '2026-10-22' && r.number === 'IT707'),
);
const target = 'src/server/data/return-flights.json';
const body =
  JSON.stringify(
    {
      version: 1,
      from: progress.requestedFrom,
      through: progress.requestedTo,
      dateBasis: progress.dateBasis,
      partial: true,
      pendingCount: 1,
      provenance: `${staging}/progress.json`,
      records,
    },
    null,
    2,
  ) + '\n';
try {
  assert.equal(
    await fs.readFile(target, 'utf8'),
    body,
    'Existing import differs; review before replacing',
  );
} catch (error) {
  if (error.code === 'ENOENT') await fs.writeFile(target, body, { flag: 'wx' });
  else throw error;
}
const log = 'data/flight-updates/return-integration-20261019';
await fs.mkdir(log, { recursive: true });
await fs.writeFile(
  path.join(log, 'import.json'),
  JSON.stringify(
    {
      records: 2967,
      sha256: sha(body),
      target,
      pendingExcluded: ['2026-10-22 IT707 NGO-TPE'],
      stagingProgress: progress,
    },
    null,
    2,
  ),
);
console.log('Imported 2967 unique return records; pending IT707 excluded.');
