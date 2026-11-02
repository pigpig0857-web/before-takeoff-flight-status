/** Save a small set of reviewed public alternative sources; no booking queries. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve(
  'data/source-samples/crawler',
  `peach-alternatives-${Date.now()}`,
);
await fs.mkdir(root, { recursive: true });
const targets = [
  ['peach-timetable', 'https://www.flypeach.com/tw/lm/st'],
  ['peach-status', 'https://www.flypeach.com/tw/lm/flightstatus'],
  ['caa-open-data', 'https://www.caa.gov.tw/article.aspx?a=294&lang=1'],
  [
    'caa-foreign-schedule',
    'https://www.caa.gov.tw/RegularForeignFlight.aspx?a=269&lang=1',
  ],
  [
    'narita-peach',
    'https://www.narita-airport.jp/en/flight/airline-search/apj/',
  ],
];
const report = {
  startedAt: new Date().toISOString(),
  scope: 'TPE Peach outbound through 2026-12-31',
  sources: [],
  integratedIntoWebsite: false,
};
const deniedHosts = new Set();
for (const [id, url] of targets) {
  const entry = { id, url, startedAt: new Date().toISOString() };
  report.sources.push(entry);
  if (deniedHosts.has(new URL(url).hostname)) {
    entry.state = 'skipped_after_source_denial';
    continue;
  }
  try {
    const r = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
    entry.httpStatus = r.status;
    const reader = r.body.getReader(),
      chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 3000000) throw new Error('Source exceeds 3 MB');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const body = Buffer.concat(chunks);
    entry.file = id + '.html';
    entry.bytes = body.length;
    entry.sha256 = createHash('sha256').update(body).digest('hex');
    await fs.writeFile(path.join(root, entry.file), body);
    entry.state = r.status === 200 ? 'downloaded' : 'unavailable';
    if (
      r.status === 403 ||
      /Access Denied|You don't have permission to access/i.test(
        body.toString('utf8'),
      )
    ) {
      entry.state = 'access_denied';
      deniedHosts.add(new URL(url).hostname);
    }
  } catch (e) {
    entry.state = 'failed';
    entry.error = e.message;
  }
  entry.finishedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(root, 'receipt.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
}
report.finishedAt = new Date().toISOString();
await fs.writeFile(
  path.join(root, 'receipt.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify({ root, ...report }, null, 2));
