import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = 'data/source-samples/crawler/return-world-20261019/pdf-refresh';
await fs.mkdir(root, { recursive: true });
const stopped = new Set();
const sha = (b) => createHash('sha256').update(b).digest('hex');
for (const [airline, base, stems] of [
  [
    'PR',
    'data/source-samples/crawler/new-airlines-20261015',
    ['pr-international-summer', 'pr-international-winter'],
  ],
  [
    'GK',
    'data/source-samples/crawler/new-airlines-20261014',
    ['jetstar-summer-pdf', 'jetstar-winter-pdf'],
  ],
])
  for (const stem of stems) {
    const receipt = JSON.parse(
      await fs.readFile(path.join(base, stem + '.receipt.json'), 'utf8'),
    );
    const key = path.join(root, stem);
    try {
      await fs.access(key + '.started.json');
      continue;
    } catch {}
    if (stopped.has(new URL(receipt.url).host)) continue;
    await fs.writeFile(
      key + '.started.json',
      JSON.stringify({ url: receipt.url, airline }),
      { flag: 'wx' },
    );
    try {
      const response = await fetch(receipt.url, {
        redirect: 'error',
        signal: AbortSignal.timeout(25000),
      });
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > 20_000_000) throw Error('Size limit');
      await fs.writeFile(key + '.body', body, { flag: 'wx' });
      const result = {
        url: receipt.url,
        status: response.status,
        sha256: sha(body),
        fetchedAt: new Date().toISOString(),
        baselineSha256: receipt.sha256,
        unchanged: sha(body) === receipt.sha256,
      };
      await fs.writeFile(
        key + '.receipt.json',
        JSON.stringify(result, null, 2),
        { flag: 'wx' },
      );
      if (!response.ok || body.subarray(0, 5).toString() !== '%PDF-')
        throw Error('Source unavailable; no retry');
      console.log(JSON.stringify({ airline, stem, ...result }));
    } catch (error) {
      stopped.add(new URL(receipt.url).host);
      await fs.writeFile(
        key + '.pending.json',
        JSON.stringify({ reason: error.message }),
      );
      console.log(airline + ': ' + error.message);
    }
  }
