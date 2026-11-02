/** Cross-check source details for each observed route / seasonal time change. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const args = process.argv.slice(2),
  python = args[args.indexOf('--python') + 1];
if (!args.includes('--python')) throw Error('--python required');
const root = path.resolve('data/source-samples/crawler/eva-yearend-2026');
const plan = JSON.parse(
  await fs.readFile(path.join(root, 'progress.json'), 'utf8'),
);
const directory = path.join(root, 'detail-crosschecks');
await fs.mkdir(directory, { recursive: true });
const manifest = [];
const cookies = new Map();
const initial = await fetch(plan.sourceUrl, {
  headers: {
    'User-Agent': 'FlightStatusResearch/0.1 (public timetable cross-check)',
    Accept: 'text/html',
  },
  redirect: 'manual',
  signal: AbortSignal.timeout(20000),
});
if (initial.status !== 200) {
  await initial.body?.cancel();
  throw Error(`HTTP ${initial.status}; source form not available`);
}
for (const item of initial.headers.getSetCookie()) {
  const pair = item.split(';')[0],
    i = pair.indexOf('=');
  if (i > 0) cookies.set(pair.slice(0, i), pair.slice(i + 1));
}
await fs.writeFile(
  path.join(directory, `session-form-${Date.now()}.html`),
  Buffer.from(await initial.arrayBuffer()),
);
for (const route of plan.routes) {
  const observed = [...route.records].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  if (!observed.length) continue;
  // First/last observations can straddle winter schedule and DST changes.
  const selected = [observed[0], observed.at(-1)];
  for (const r of selected) {
    const file = `${route.airport}-${r.date}-${r.number}.html`;
    const entry = {
      airport: route.airport,
      number: r.number,
      date: r.date,
      file,
      status: 'pending',
    };
    manifest.push(entry);
    try {
      const url = new URL(r.detailLink);
      assert.equal(url.origin, 'https://booking.evaair.com');
      assert.equal(
        url.pathname.toLowerCase(),
        '/flyeva/eva/b2c/flight-details.aspx',
      );
      let raw;
      try {
        raw = await fs.readFile(path.join(directory, file));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        await delay(1500);
        const response = await fetch(url, {
          headers: {
            'User-Agent':
              'FlightStatusResearch/0.1 (public timetable cross-check)',
            Accept: 'text/html',
            Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(20000),
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          throw Error(
            `HTTP ${response.status}; refused, no redirects followed`,
          );
        }
        raw = Buffer.from(await response.arrayBuffer());
        assert.ok(raw.length < 2000000);
        await fs.writeFile(path.join(directory, file), raw);
        await fs.writeFile(
          path.join(directory, file + '.receipt.json'),
          JSON.stringify(
            {
              url: url.href,
              httpStatus: 200,
              observedAt: new Date().toISOString(),
              sha256: createHash('sha256').update(raw).digest('hex'),
            },
            null,
            2,
          ),
        );
      }
      const receipt = JSON.parse(
        await fs.readFile(path.join(directory, file + '.receipt.json'), 'utf8'),
      );
      assert.equal(receipt.httpStatus, 200);
      assert.equal(
        receipt.sha256,
        createHash('sha256').update(raw).digest('hex'),
      );
      assert.equal(receipt.url, r.detailLink);
      const parsed = JSON.parse(
        execFileSync(
          python,
          [
            'scripts/crawler/fetch-eva-form.py',
            '--parse-detail-file',
            path.join(directory, file),
          ],
          { encoding: 'utf8', timeout: 10000, maxBuffer: 1000000 },
        ),
      );
      const text = parsed.detailText;
      const match =
        /^Flight details (BR\d+)Operated By：(EVA AIR|EVA Airways)(?: View this flight status)? ([A-Z][a-z]{2}\. \d{1,2}, \d{4}) (\d{2}:\d{2}) TAIPEI TAIPEI \(TAOYUAN\)(?: Terminal (\d+))? (\d{2}:\d{2})([+-]\d+)? (.*?) Flight Time (\d+) Hours?(?: (\d+) Minutes?)?(?: |$)/.exec(
          text,
        );
      assert.ok(match, `Unreviewed detail format: ${text.slice(0, 240)}`);
      assert.equal(match[1].replace(/^BR0+(?=\d)/, 'BR'), r.number);
      assert.equal(
        new Date(`${match[3]} UTC`).toISOString().slice(0, 10),
        r.date,
      );
      assert.equal(match[4], r.departureTime);
      assert.equal(match[6], r.arrivalTime);
      assert.equal(Number(match[7] ?? 0), r.arrivalDayOffset);
      entry.status = 'verified_table_detail_times_and_operator';
      entry.durationMinutes = Number(match[9]) * 60 + Number(match[10] ?? 0);
      entry.arrivalLabel = match[8];
      entry.sourceOperator = match[2];
      entry.detailText = text;
    } catch (e) {
      entry.status = 'failed';
      entry.error = e.message;
    }
    await fs.writeFile(
      path.join(directory, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );
    console.log(JSON.stringify({ ...entry, detailText: undefined }));
    if (entry.error?.startsWith('HTTP ')) throw Error(entry.error);
  }
}
console.log(
  JSON.stringify({
    verified: manifest.filter((m) => m.status.startsWith('verified')).length,
    failed: manifest.filter((m) => m.status === 'failed').length,
  }),
);
