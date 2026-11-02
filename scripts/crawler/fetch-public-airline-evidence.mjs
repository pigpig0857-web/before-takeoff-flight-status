// Bounded anonymous source read. Each observation gets an exclusive file/receipt.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve(
  'data/source-samples/crawler/additional-airlines-20261013',
);
const [id, address] = process.argv.slice(2);
if (!id || !/^[a-z0-9-]+$/.test(id)) throw new Error('Evidence name required');
const url = new URL(address);
if (
  url.protocol !== 'https:' ||
  url.username ||
  url.password ||
  ![
    'www.starlux-airlines.com',
    'booking.china-airlines.com',
    'booking.flyscoot.com',
    'www.flyscoot.com',
    'www.hkexpress.com',
    'ecapi.starlux-airlines.com',
  ].includes(url.hostname)
)
  throw new Error('Unreviewed source host');
await mkdir(root, { recursive: true });
const base = path.join(root, id);
await writeFile(
  `${base}.started.json`,
  JSON.stringify({ url: url.href, startedAt: new Date().toISOString() }),
  { flag: 'wx' },
);
try {
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
    headers: { accept: '*/*' },
  });
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 20_000_000) throw new Error('Response size limit');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const body = Buffer.concat(chunks);
  await writeFile(`${base}.body`, body, { flag: 'wx' });
  const receipt = {
    url: url.href,
    status: response.status,
    contentType: response.headers.get('content-type'),
    redirect: response.headers.get('location'),
    fetchedAt: new Date().toISOString(),
    bytes,
    sha256: createHash('sha256').update(body).digest('hex'),
    authenticated: false,
    state:
      response.status === 200
        ? 'downloaded_not_yet_validated'
        : 'stopped_non_200',
  };
  await writeFile(`${base}.receipt.json`, JSON.stringify(receipt, null, 2), {
    flag: 'wx',
  });
  console.log(JSON.stringify(receipt));
} catch (error) {
  await writeFile(
    `${base}.error.json`,
    JSON.stringify({ pending: true, message: error.message }),
    { flag: 'wx' },
  );
  throw error;
}
