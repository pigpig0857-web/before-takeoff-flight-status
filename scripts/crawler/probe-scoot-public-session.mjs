// Use the same ephemeral anonymous session initialization as the official site.
// Never read browser cookies or user credentials; never save the anonymous token.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(
  'data/source-samples/crawler/additional-airlines-20261013',
);
const url = 'https://booking.flyscoot.com/api/v1/account/anonymous';
const request = { origin: 'TPE', destination: 'SIN', beginDate: '2026-12-31' };
const prefix = path.join(root, 'scoot-public-session-sin-1231');
await writeFile(
  `${prefix}.started.json`,
  JSON.stringify({ url, request, startedAt: new Date().toISOString() }),
  { flag: 'wx' },
);
try {
  const session = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  const bytes = Buffer.from(await session.arrayBuffer());
  // Session response may contain an ephemeral credential. Save only metadata.
  const sessionReceipt = {
    url,
    status: session.status,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    fetchedAt: new Date().toISOString(),
    credentialSaved: false,
    credentialSource: 'new_official_anonymous_session',
  };
  await writeFile(
    `${prefix}.session-receipt.json`,
    JSON.stringify(sessionReceipt, null, 2),
    { flag: 'wx' },
  );
  if (!session.ok)
    throw new Error(
      `Anonymous session HTTP ${session.status}; stop without retry`,
    );
  const json = JSON.parse(bytes);
  if (typeof json.data?.accessToken !== 'string' || !json.data.accessToken)
    throw new Error('No anonymous session returned');
  const cookie = session.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    Authorization: json.data.accessToken,
  };
  if (cookie) headers.Cookie = cookie;
  const scheduleUrl = 'https://booking.flyscoot.com/api/flights/schedules';
  const response = await fetch(scheduleUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  const body = Buffer.from(await response.arrayBuffer());
  await writeFile(`${prefix}.body`, body, { flag: 'wx' });
  const receipt = {
    url: scheduleUrl,
    request,
    status: response.status,
    bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    fetchedAt: new Date().toISOString(),
    mode: 'official_anonymous_session',
    credentialSaved: false,
  };
  await writeFile(`${prefix}.receipt.json`, JSON.stringify(receipt, null, 2), {
    flag: 'wx',
  });
  if (!response.ok)
    throw new Error(`Schedule HTTP ${response.status}; stop without retry`);
  const data = JSON.parse(body);
  if (!Array.isArray(data.trips))
    throw new Error(
      'No usable timetable returned after ordinary anonymous initialization',
    );
  console.log(
    JSON.stringify({
      ...receipt,
      days: data.trips.length,
      journeys: data.trips.reduce((n, d) => n + d.journeys.length, 0),
      first: data.trips[0],
    }),
  );
} catch (error) {
  await writeFile(
    `${prefix}.pending.json`,
    JSON.stringify({ pending: true, message: error.message }, null, 2),
    { flag: 'wx' },
  );
  console.error(error.message);
  process.exitCode = 1;
}
