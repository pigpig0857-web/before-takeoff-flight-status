/** Public airport guidance, kept separate from date-specific flight details. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve(
  'data/source-samples/crawler',
  `peach-guides-${Date.now()}`,
);
const base =
  'https://www.flypeach.com/en/lm/ai/airports/airportguide_international/';
await fs.mkdir(root, { recursive: true });
const sources = [];
for (const airport of ['tpe', 'kix', 'nrt', 'hnd', 'ngo', 'oka']) {
  const url = base + airport;
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(`Stopped at ${airport}: HTTP ${response.status}`);
  const html = await response.text();
  if (html.length > 2000000)
    throw new Error('Airport guide exceeds size limit');
  const headings = [
    ...html.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi),
  ].map((m) =>
    m[1]
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  if (
    !headings.some((h) => /Arrival/i.test(h)) ||
    !headings.some((h) => /Departure/i.test(h))
  )
    throw new Error(`Airport guide schema changed: ${airport}`);
  await fs.writeFile(path.join(root, `${airport}.html`), html);
  sources.push({
    airport: airport.toUpperCase(),
    url,
    fetchedAt: new Date().toISOString(),
    sha256: createHash('sha256').update(html).digest('hex'),
    headings,
  });
}
await fs.writeFile(
  path.join(root, 'receipt.json'),
  JSON.stringify({ version: 1, sources }, null, 2),
);
console.log(JSON.stringify({ root, sources }, null, 2));
