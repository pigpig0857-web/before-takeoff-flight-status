// Anonymous public schedule research. A saved request is never silently repeated.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [rootArg, planFile] = process.argv.slice(2);
if (!rootArg || !planFile) throw new Error('Research directory and plan JSON required');
const root = path.resolve(rootArg);
const workspace = path.resolve('data/source-samples/crawler');
if (!root.startsWith(workspace + path.sep)) throw new Error('Research directory outside workspace');
const plan = JSON.parse(await fs.readFile(planFile, 'utf8'));
const hosts = new Set(plan.allowedHosts);
await fs.mkdir(root, { recursive: true });
for (const request of plan.requests) {
  if (!/^[a-z0-9-]+$/.test(request.id)) throw new Error('Invalid evidence ID');
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.username || url.password || !hosts.has(url.hostname))
    throw new Error('Unreviewed source');
  const base = path.join(root, request.id);
  try {
    await fs.access(`${base}.started.json`);
    console.log(JSON.stringify({ id: request.id, state: 'saved_request_not_repeated' }));
    continue;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const startedAt = new Date().toISOString();
  await fs.writeFile(`${base}.started.json`, JSON.stringify({ ...request, startedAt }), { flag: 'wx' });
  try {
    const response = await fetch(url, {
      method: request.method || 'GET',
      body: request.body,
      headers: request.headers || { accept: '*/*' },
      redirect: 'manual',
      signal: AbortSignal.timeout(25000),
    });
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 20_000_000) {
        await reader.cancel();
        throw new Error('Source size limit');
      }
      chunks.push(part.value);
    }
    const body = Buffer.concat(chunks);
    await fs.writeFile(`${base}.body`, body, { flag: 'wx' });
    const receipt = {
      id: request.id, url: url.href, method: request.method || 'GET', startedAt,
      fetchedAt: new Date().toISOString(), status: response.status,
      contentType: response.headers.get('content-type'),
      location: response.headers.get('location'), bytes,
      sha256: createHash('sha256').update(body).digest('hex'), authenticated: false,
      state: response.status === 200 ? 'downloaded_not_yet_validated' : 'stopped_non_200',
    };
    await fs.writeFile(`${base}.receipt.json`, JSON.stringify(receipt, null, 2), { flag: 'wx' });
    console.log(JSON.stringify(receipt));
  } catch (error) {
    const pending = { id: request.id, url: url.href, state: 'pending', error: error.message, startedAt };
    await fs.writeFile(`${base}.pending.json`, JSON.stringify(pending, null, 2), { flag: 'wx' });
    console.log(JSON.stringify(pending));
  }
}
