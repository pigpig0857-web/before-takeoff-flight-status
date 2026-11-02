/** Download the two official international schedule PDFs. No website import. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const from = args.includes('--from') ? value('--from') : today;
if (
  !/^\d{4}-\d{2}-\d{2}$/.test(from || '') ||
  !Number.isFinite(Date.parse(from)) ||
  new Date(from).toISOString().slice(0, 10) !== from ||
  from > '2026-12-31'
)
  throw Error('Invalid year-end start date');
const base = path.resolve('data/source-samples/crawler');
const root = args.includes('--output-dir')
  ? path.resolve(value('--output-dir'))
  : path.join(base, `peach-${Date.now()}`);
const relative = path.relative(base, root);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
  throw Error('Output outside source samples');
const indexUrl = 'https://www.flypeach.com/en/lm/st/routemap';
async function download(url) {
  const target = new URL(url);
  if (
    target.origin !== 'https://www.flypeach.com' ||
    target.username ||
    target.password
  )
    throw Error('Unreviewed source origin');
  const response = await fetch(url, {
    redirect: 'error',
    headers: {
      'User-Agent': 'FlightStatusResearch/0.1 (public timetable collection)',
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Stopped HTTP ${response.status}: ${url}`);
  const reader = response.body.getReader(),
    chunks = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > 10000000) throw new Error('Source exceeds 10 MB');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const body = Buffer.concat(chunks);
  return {
    body,
    fetchedAt: new Date().toISOString(),
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}
await fs.mkdir(path.dirname(root), { recursive: true });
await fs.mkdir(root); // A collection never replaces an earlier run.
const receipt = {
  version: 1,
  indexUrl,
  requestedFrom: from,
  requestedTo: '2026-12-31',
  departureAirport: 'TPE',
  sources: [],
  status: 'collecting',
  integratedIntoWebsite: false,
};
const save = async () => {
  await fs.writeFile(
    path.join(root, 'receipt.json.tmp'),
    JSON.stringify(receipt, null, 2),
  );
  await fs.rename(
    path.join(root, 'receipt.json.tmp'),
    path.join(root, 'receipt.json'),
  );
};
await save();
try {
  const index = await download(indexUrl);
  await fs.writeFile(path.join(root, 'source-index.html'), index.body);
  Object.assign(receipt, {
    indexFetchedAt: index.fetchedAt,
    indexSha256: index.sha256,
  });
  await save();
  const urls = [
    ...index.body
      .toString('utf8')
      .matchAll(/href=["']([^"']+_int_EN\.pdf)["']/g),
  ].map((m) => new URL(m[1], indexUrl).href);
  const chosen = [
    { id: 'summer', from: '2026-03-29', to: '2026-10-24' },
    { id: 'winter', from: '2026-10-25', to: '2027-03-27' },
  ].map((source) => {
    const period = `${source.from.replaceAll('-', '')}-${source.to.replaceAll('-', '')}`;
    const matches = [...new Set(urls.filter((url) => url.includes(period)))];
    if (matches.length !== 1)
      throw new Error(
        `Expected one official ${source.id} PDF, got ${matches.length}`,
      );
    return { ...source, url: matches[0] };
  });
  for (const source of chosen) {
    const first = await download(source.url);
    if (!first.body.subarray(0, 5).equals(Buffer.from('%PDF-')))
      throw new Error('Not a PDF');
    const file = `${source.id}.pdf`;
    await fs.writeFile(path.join(root, file), first.body);
    const evidence = {
      ...source,
      file,
      bytes: first.body.length,
      fetchedAt: first.fetchedAt,
      sha256: first.sha256,
      repeatHashMatches: false,
    };
    receipt.sources.push(evidence);
    await save();
    const repeat = await download(source.url);
    if (repeat.sha256 !== first.sha256)
      throw new Error('PDF changed during collection; rerun required');
    Object.assign(evidence, {
      repeatedAt: repeat.fetchedAt,
      repeatedSha256: repeat.sha256,
      repeatHashMatches: true,
    });
    await save();
  }
  receipt.status = 'downloaded';
} catch (error) {
  receipt.status = 'pending_confirmation';
  receipt.error = error.message;
  process.exitCode = 1;
}
receipt.finishedAt = new Date().toISOString();
await save();
console.log(JSON.stringify({ root, ...receipt }, null, 2));
