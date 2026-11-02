// Isolated anonymous official timetable observation. Never imports into the site.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve(
  'data/source-samples/crawler/return-expansion-20261019',
);
const url = 'https://api-cms.tigerairtw.com/api/flight-schedules/merge';
await fs.mkdir(root); // Existing run must be resumed offline, never re-requested.
const sha = (body) => createHash('sha256').update(body).digest('hex');
const dir = path.resolve('src/server/data');
const beforeHashes = {};
for (const name of (await fs.readdir(dir)).filter((n) => n.endsWith('.json'))) {
  beforeHashes[name] = sha(await fs.readFile(path.join(dir, name)));
}
await fs.writeFile(
  path.join(root, 'website-before.json'),
  JSON.stringify(beforeHashes, null, 2),
  { flag: 'wx' },
);
const receipt = {
  url,
  startedAt: new Date().toISOString(),
  status: 'started',
  integratedIntoWebsite: false,
};
const save = () =>
  fs.writeFile(
    path.join(root, 'tigerair-receipt.json'),
    JSON.stringify(receipt, null, 2),
  );
await save();
try {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: { accept: 'application/json', 'x-language': 'zh-TW' },
  });
  receipt.httpStatus = response.status;
  const chunks = [];
  let bytes = 0;
  for await (const part of response.body) {
    bytes += part.length;
    if (bytes > 10_000_000) throw Error('Size limit');
    chunks.push(part);
  }
  const body = Buffer.concat(chunks);
  await fs.writeFile(path.join(root, 'tigerair-raw.json'), body, {
    flag: 'wx',
  });
  Object.assign(receipt, {
    bytes,
    sha256: sha(body),
    fetchedAt: new Date().toISOString(),
  });
  if (!response.ok) throw Error(`HTTP ${response.status}; stopped, no retry`);
  if (!Array.isArray(JSON.parse(body).data))
    throw Error('Unexpected response schema');
  receipt.status = 'downloaded';
} catch (error) {
  receipt.status = 'pending_confirmation';
  receipt.error = error.message;
  process.exitCode = 1;
}
await save();
console.log(JSON.stringify(receipt, null, 2));
