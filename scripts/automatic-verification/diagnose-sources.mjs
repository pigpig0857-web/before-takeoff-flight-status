// One bounded read per published entry point; retain Location/cause, never retry.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const root = path.resolve(
  'data/source-samples/crawler',
  `source-diagnosis-${new Date().toISOString().replaceAll(':', '-')}`,
);
await fs.mkdir(root, { recursive: true });
const vn = JSON.parse(
  await fs.readFile('src/server/data/vietnam-flights.json', 'utf8'),
);
const sample = vn.records.find(
  (r) => r.date === '2026-12-31' && r.airport === 'SGN',
);
if (!sample) throw new Error('No saved official VN reference');
const sources = [
  [
    'eva',
    'https://booking.evaair.com/flyeva/eva/b2c/flight-schedules.aspx?lang=en-hk',
  ],
  ['jeju', 'https://www.jejuair.net/en/prepare/flight/viewScheduleInfo.do'],
  ['vietnam', sample.evidence.sourceUrl],
];
const results = [];
for (const [airline, url] of sources) {
  const stem = path.join(root, airline);
  await fs.writeFile(
    stem + '.started.json',
    JSON.stringify({
      url,
      method: 'GET',
      startedAt: new Date().toISOString(),
      authenticated: false,
    }),
    { flag: 'wx' },
  );
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(25000),
    });
    const reader = response.body.getReader(),
      parts = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 4_000_000) {
        await reader.cancel();
        throw new Error('Source size limit');
      }
      parts.push(part.value);
    }
    const body = Buffer.concat(parts);
    await fs.writeFile(stem + '.body', body, { flag: 'wx' });
    const receipt = {
      airline,
      url,
      status: response.status,
      location: response.headers.get('location'),
      contentType: response.headers.get('content-type'),
      fetchedAt: new Date().toISOString(),
      bytes: size,
      sha256: createHash('sha256').update(body).digest('hex'),
      authenticated: false,
      followedRedirects: false,
    };
    await fs.writeFile(
      stem + '.receipt.json',
      JSON.stringify(receipt, null, 2),
      { flag: 'wx' },
    );
    results.push(receipt);
  } catch (e) {
    const pending = {
      airline,
      url,
      state: 'pending',
      error: e.message,
      cause: e.cause?.message,
      code: e.cause?.code,
      at: new Date().toISOString(),
    };
    await fs.writeFile(
      stem + '.pending.json',
      JSON.stringify(pending, null, 2),
      { flag: 'wx' },
    );
    results.push(pending);
  }
  await fs.writeFile(
    path.join(root, 'progress.json'),
    JSON.stringify({ state: 'saved', results }, null, 2),
  );
}
console.log(JSON.stringify({ root, results }, null, 2));
