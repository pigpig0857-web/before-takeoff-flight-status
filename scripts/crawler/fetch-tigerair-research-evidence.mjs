import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(
  'data/source-samples/crawler/tigerair-research-20261013',
);
const sources = [
  [
    'openflights-airports.dat',
    'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat',
  ],
  [
    'merged-repeat.json',
    'https://api-cms.tigerairtw.com/api/flight-schedules/merge',
  ],
];
for (const [name, url] of sources) {
  // Reserve the receipt before the request, so interrupted runs are not silently repeated.
  await writeFile(
    path.join(root, `${name}.started.json`),
    JSON.stringify({ url, startedAt: new Date().toISOString() }),
    { flag: 'wx' },
  );
  try {
    const response = await fetch(url, {
      headers: { accept: '*/*', 'x-language': 'zh-TW' },
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    const body = Buffer.from(await response.arrayBuffer());
    await writeFile(path.join(root, name), body, { flag: 'wx' });
    const receipt = {
      url,
      status: response.status,
      bytes: body.length,
      fetchedAt: new Date().toISOString(),
      sha256: createHash('sha256').update(body).digest('hex'),
    };
    await writeFile(
      path.join(root, `${name}.receipt.json`),
      JSON.stringify(receipt, null, 2),
      { flag: 'wx' },
    );
    console.log(JSON.stringify({ name, ...receipt }));
    if (!response.ok) throw new Error(`HTTP ${response.status}; do not retry`);
  } catch (error) {
    await writeFile(
      path.join(root, `${name}.error.json`),
      JSON.stringify({ message: error.message, pending: true }),
      { flag: 'wx' },
    );
    throw error;
  }
}
