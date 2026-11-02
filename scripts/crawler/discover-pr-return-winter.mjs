// A removed PDF is not an access challenge: follow the canonical published index.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = 'data/source-samples/crawler/return-world-20261019/pdf-refresh';
const index =
  'https://www.philippineairlines.com/ph/en/flight-timetable-page.model.json';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const marker = root + '/pr-index.started.json';
async function download(url, stem) {
  const r = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(25000),
  });
  const b = Buffer.from(await r.arrayBuffer());
  await fs.writeFile(root + '/' + stem + '.body', b, { flag: 'wx' });
  await fs.writeFile(
    root + '/' + stem + '.receipt.json',
    JSON.stringify(
      {
        url,
        status: r.status,
        sha256: sha(b),
        fetchedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  if (!r.ok) throw Error(`HTTP ${r.status}; stop without retry`);
  return b;
}
try {
  let body;
  try {
    const receipt = JSON.parse(
      await fs.readFile(root + '/pr-index.receipt.json', 'utf8'),
    );
    body = await fs.readFile(root + '/pr-index.body');
    if (receipt.status !== 200 || sha(body) !== receipt.sha256)
      throw Error('Saved index invalid');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.writeFile(marker, JSON.stringify({ url: index }), { flag: 'wx' });
    body = await download(index, 'pr-index');
  }
  const text = JSON.stringify(JSON.parse(body));
  const urls = [
    ...new Set(
      [
        ...text.matchAll(
          /(?:https:\/\/www\.philippineairlines\.com)?\/content\/dam\/[^"'\s<>\\]+\.pdf/gi,
        ),
      ].map((m) => new URL(m[0], 'https://www.philippineairlines.com').href),
    ),
  ];
  await fs.writeFile(
    root + '/pr-index-links.json',
    JSON.stringify(urls, null, 2),
  );
  const winter = urls.filter((u) =>
    /(?:INTL|International).*(?:WINTER|W26)/i.test(u),
  );
  if (winter.length !== 1) throw Error('Winter link not unambiguously found');
  const old = JSON.parse(
    await fs.readFile(root + '/pr-international-winter.receipt.json', 'utf8'),
  );
  if (winter[0] === old.url)
    throw Error('Index still links to removed PDF; do not re-request');
  const pdf = await download(winter[0], 'pr-international-winter-current');
  if (pdf.subarray(0, 5).toString() !== '%PDF-') throw Error('Not a PDF');
  console.log(
    JSON.stringify({ state: 'new_published_pdf_saved', url: winter[0] }),
  );
} catch (error) {
  await fs.writeFile(
    root + '/pr-index.pending.json',
    JSON.stringify({ reason: error.message }),
  );
  console.log(error.message);
}
