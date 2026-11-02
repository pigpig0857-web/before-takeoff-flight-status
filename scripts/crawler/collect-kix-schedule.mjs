// Normal public Drupal timetable form; no login, booking, challenge bypass, or site import.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const root = path.resolve('data/source-samples/crawler/jta-jetstar-completeness-20261014');
const daily = path.join(root, 'kix-daily');
await fs.mkdir(daily, { recursive: true });
const endpoint = 'https://www.kansai-airport.or.jp/tw/flight/schedule?ajax_form=1';
const read = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const hash = body => createHash('sha256').update(body).digest('hex');
const dates = [];
for (let d = new Date('2026-10-14T00:00:00Z'); d <= new Date('2026-12-31T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) dates.push(d.toISOString().slice(0, 10));
let progress;
try { progress = await read(path.join(daily, 'progress.json')); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const bootstrap = await read(path.join(root, 'kix-tpe-kix-1110.body'));
  progress = { state: 'collecting', query: { from: 'TPE', to: 'KIX' }, from: dates[0], through: dates.at(-1), nextBuildId: bootstrap.find(c => c.command === 'update_build_id').new, completed: [], pending: [], integratedIntoWebsite: false };
}
async function checkpoint() {
  progress.savedAt = new Date().toISOString();
  const tmp = path.join(daily, `progress-${randomUUID()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(progress, null, 2), { flag: 'wx' });
  await fs.rename(tmp, path.join(daily, 'progress.json'));
}
function validate(bytes, date) {
  const commands = JSON.parse(bytes.toString('utf8'));
  const insert = commands.find(c => c.command === 'insert' && c.selector === '#flight-results-wrapper');
  if (!insert || typeof insert.data !== 'string' || !insert.data.includes('flight-list--schedule')) throw new Error('No valid timetable result');
  const resultDates = [...new Set([...insert.data.matchAll(/outboundDate=(\d{4}-\d{2}-\d{2})/g)].map(m => m[1]))];
  if (resultDates.length !== 1 || resultDates[0] !== date) throw new Error('Response departure date not confirmed');
  const build = commands.find(c => c.command === 'update_build_id');
  return { commands, insert, nextBuildId: build?.new || progress.nextBuildId };
}
for (const date of dates) {
  if (progress.completed.some(c => c.date === date)) continue;
  if (progress.state === 'stopped_pending') throw new Error('Saved request pending; explicit review required before another request');
  const id = `kix-tpe-kix-${date}`;
  const base = path.join(daily, id);
  try { await fs.access(`${base}.started.json`); throw new Error(`Unfinished saved request requires review: ${id}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Reuse the already verified sample without repeating its successful query.
  if (date === '2026-11-10') {
    const receipt = await read(path.join(root, 'kix-tpe-kix-1110.receipt.json'));
    const bytes = await fs.readFile(path.join(root, 'kix-tpe-kix-1110.body'));
    if (hash(bytes) !== receipt.sha256 || receipt.status !== 200) throw new Error('Sample evidence changed');
    validate(bytes, date);
    progress.completed.push({ date, state: 'saved_success_reused', file: 'kix-tpe-kix-1110.body', sha256: receipt.sha256 });
    await checkpoint();
    continue;
  }
  const params = new URLSearchParams({ from: 'TPE', to: 'KIX', date, form_id: 'schedule_flight_search_form', form_build_id: progress.nextBuildId, op: '搜尋' });
  const startedAt = new Date().toISOString();
  await fs.writeFile(`${base}.started.json`, JSON.stringify({ id, url: endpoint, method: 'POST', query: { from: 'TPE', to: 'KIX', date }, startedAt, authenticated: false }), { flag: 'wx' });
  try {
    const response = await fetch(endpoint, { method: 'POST', body: params, headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual', signal: AbortSignal.timeout(25000) });
    const reader = response.body.getReader(), chunks = [];
    let bytes = 0;
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length;
      if (bytes > 3_000_000) { await reader.cancel(); throw new Error('Response size limit'); }
      chunks.push(part.value);
    }
    const body = Buffer.concat(chunks);
    await fs.writeFile(`${base}.body`, body, { flag: 'wx' });
    const receipt = { id, url: endpoint, method: 'POST', query: { from: 'TPE', to: 'KIX', date }, startedAt, fetchedAt: new Date().toISOString(), status: response.status, bytes, sha256: hash(body), authenticated: false, source: 'Kansai Airports published schedule supplied by OAG' };
    await fs.writeFile(`${base}.receipt.json`, JSON.stringify(receipt, null, 2), { flag: 'wx' });
    if (response.status !== 200) throw new Error(`HTTP ${response.status}; no retry`);
    const result = validate(body, date);
    progress.nextBuildId = result.nextBuildId;
    progress.completed.push({ date, state: 'saved_valid_response', file: `kix-daily/${id}.body`, sha256: receipt.sha256 });
    await checkpoint();
    console.log(JSON.stringify({ date, completed: progress.completed.length, expected: dates.length }));
  } catch (error) {
    const pending = { date, state: 'pending', error: error.message };
    await fs.writeFile(`${base}.pending.json`, JSON.stringify(pending, null, 2), { flag: 'wx' });
    progress.pending.push(pending);
    progress.state = 'stopped_pending';
    progress.unqueried = dates.filter(d => !progress.completed.some(c => c.date === d) && d !== date);
    await checkpoint();
    throw error;
  }
  await new Promise(resolve => setTimeout(resolve, 500));
}
progress.state = 'completed';
progress.unqueried = [];
await checkpoint();
console.log(JSON.stringify({ state: progress.state, completed: progress.completed.length }));
