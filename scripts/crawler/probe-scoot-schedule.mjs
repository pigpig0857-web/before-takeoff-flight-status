// Public timetable query copied from the official client. No session tokens.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(
  'data/source-samples/crawler/additional-airlines-20261013',
);
const [destination = 'SIN', beginDate = '2026-12-31'] = process.argv.slice(2);
const options = JSON.parse(
  await readFile(path.join(root, 'scoot-tpe-destinations.body'), 'utf8'),
);
if (
  !options.some((o) => o.code === destination) ||
  !/^2026-\d{2}-\d{2}$/.test(beginDate)
)
  throw new Error('Unreviewed query');
const prefix = path.join(root, `scoot-${destination}-${beginDate}`);
const request = { origin: 'TPE', destination, beginDate };
const url = 'https://booking.flyscoot.com/api/flights/schedules';
await writeFile(
  `${prefix}.request.json`,
  JSON.stringify(
    { url, request, startedAt: new Date().toISOString() },
    null,
    2,
  ),
  { flag: 'wx' },
);
try {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(request),
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > 5_000_000) throw new Error('Response size limit');
  await writeFile(`${prefix}.body`, body, { flag: 'wx' });
  const receipt = {
    url,
    request,
    status: response.status,
    contentType: response.headers.get('content-type'),
    bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    fetchedAt: new Date().toISOString(),
    authenticated: false,
  };
  await writeFile(`${prefix}.receipt.json`, JSON.stringify(receipt, null, 2), {
    flag: 'wx',
  });
  console.log(JSON.stringify(receipt));
  if (!response.ok)
    throw new Error(`HTTP ${response.status}; stop without retry`);
  const json = JSON.parse(body);
  if (!Array.isArray(json.trips))
    throw new Error(`No usable timetable returned: ${JSON.stringify(json)}`);
  console.log(
    JSON.stringify({
      keys: Object.keys(json),
      days: json.trips?.length,
      first: json.trips?.[0],
    }),
  );
} catch (error) {
  await writeFile(
    `${prefix}.pending.json`,
    JSON.stringify({ message: error.message, pending: true }),
    { flag: 'wx' },
  );
  throw error;
}
