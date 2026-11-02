import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = 'data/source-samples/crawler/return-world-20261019/kix';
await fs.mkdir(root, { recursive: true });
const url = 'https://www.kansai-airport.or.jp/tw/flight/schedule';
const sha = (b) => createHash('sha256').update(b).digest('hex');
async function save(name, value) {
  await fs.writeFile(root + '/' + name, JSON.stringify(value, null, 2));
}
async function read(url, stem, body) {
  await fs.writeFile(
    root + '/' + stem + '.started.json',
    JSON.stringify({ url, body }),
    { flag: 'wx' },
  );
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    body: body ? new URLSearchParams(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(25000),
  });
  const raw = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(root + '/' + stem + '.body', raw, { flag: 'wx' });
  await save(stem + '.receipt.json', {
    url,
    status: res.status,
    sha256: sha(raw),
    fetchedAt: new Date().toISOString(),
    query: body ? { from: body.from, to: body.to, date: body.date } : null,
  });
  if (res.status !== 200) throw Error('HTTP ' + res.status + '; no retry');
  return raw;
}
let completed = [];
try {
  let progress;
  try {
    progress = JSON.parse(await fs.readFile(root + '/progress.json', 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (progress?.state === 'stopped')
    throw Error('Saved source stopped; do not retry');
  let build;
  if (progress) {
    completed = progress.completed;
    build = progress.build;
  } else {
    const html = (await read(url, 'index')).toString();
    if (/access denied|captcha|verify you are human/i.test(html))
      throw Error('Source challenge; stop');
    const input = html.match(/<input[^>]+name="form_build_id"[^>]*>/)?.[0];
    build = input?.match(/value="([^"]+)"/)?.[1];
    if (!build) throw Error('No published form identifier');
  }
  for (
    let ms = Date.parse('2026-10-19T00:00:00Z');
    ms <= Date.parse('2026-12-31T00:00:00Z');
    ms += 86400000
  ) {
    const date = new Date(ms).toISOString().slice(0, 10);
    if (completed.includes(date)) continue;
    const response = JSON.parse(
      (
        await read(url + '?ajax_form=1', date, {
          from: 'KIX',
          to: 'TPE',
          date,
          form_id: 'schedule_flight_search_form',
          form_build_id: build,
          op: '搜尋',
        })
      ).toString(),
    );
    const result = response.find(
      (c) => c.command === 'insert' && c.selector === '#flight-results-wrapper',
    );
    if (!result?.data?.includes('flight-list--schedule'))
      throw Error('No usable timetable; not zero-flight proof');
    const dates = [
      ...new Set(
        [...result.data.matchAll(/outboundDate=(\d{4}-\d{2}-\d{2})/g)].map(
          (m) => m[1],
        ),
      ),
    ];
    if (dates.length !== 1 || dates[0] !== date)
      throw Error('Returned date not confirmed');
    build = response.find((c) => c.command === 'update_build_id')?.new || build;
    completed.push(date);
    await save('progress.json', { state: 'collecting', build, completed });
    if (completed.length % 10 === 0)
      console.log(JSON.stringify({ completed: completed.length, planned: 74 }));
    await new Promise((r) => setTimeout(r, 600));
  }
  await save('progress.json', { state: 'downloaded', build, completed });
} catch (error) {
  await save('progress.json', {
    state: 'stopped',
    completed,
    error: error.message,
  });
  console.log(error.message);
  process.exitCode = 1;
}
