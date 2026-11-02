/** Inspect the public booking application's declared assets; no login or challenge handling. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve(
  'data/source-samples/crawler',
  `peach-booking-public-${Date.now()}`,
);
await fs.mkdir(root, { recursive: true });
const url = 'https://booking.flypeach.com/en/';
const response = await fetch(url, {
  redirect: 'manual',
  signal: AbortSignal.timeout(30000),
});
const raw = Buffer.from(await response.arrayBuffer());
const receipt = {
  url,
  status: response.status,
  fetchedAt: new Date().toISOString(),
  sha256: createHash('sha256').update(raw).digest('hex'),
  bytes: raw.length,
};
await fs.writeFile(path.join(root, 'index.html'), raw);
const scripts = [
  ...raw.toString('utf8').matchAll(/<script[^>]+src=["']([^"']+)["']/gi),
].map((m) => new URL(m[1], url).href);
await fs.writeFile(
  path.join(root, 'receipt.json'),
  JSON.stringify({ ...receipt, scripts }, null, 2),
);
console.log(JSON.stringify({ root, ...receipt, scripts }, null, 2));
if (response.status !== 200)
  throw new Error('Public booking page unavailable; stopped');
if (process.argv.includes('--assets')) {
  const appUrls = scripts.filter((value) =>
    value.startsWith('https://booking.flypeach.com/react/assets/flight-'),
  );
  if (appUrls.length !== 1) throw new Error('Public application asset changed');
  const assetResponse = await fetch(appUrls[0], {
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!assetResponse.ok)
    throw new Error(`Application asset HTTP ${assetResponse.status}`);
  const asset = Buffer.from(await assetResponse.arrayBuffer());
  if (asset.length > 10000000)
    throw new Error('Application asset exceeds limit');
  await fs.writeFile(path.join(root, 'application.js'), asset);
  const assetReceipt = {
    url: appUrls[0],
    status: assetResponse.status,
    bytes: asset.length,
    fetchedAt: new Date().toISOString(),
    sha256: createHash('sha256').update(asset).digest('hex'),
  };
  await fs.writeFile(
    path.join(root, 'application.receipt.json'),
    JSON.stringify(assetReceipt, null, 2),
  );
  const content = asset.toString('utf8');
  const routes = [
    ...new Set(
      [
        ...content.matchAll(
          /["'`]((?:https:\/\/[^\s"'`]+)|(?:\/[^\s"'`]*(?:flight|search|api)[^\s"'`]*))["'`]/gi,
        ),
      ].map((m) => m[1]),
    ),
  ];
  console.log(
    JSON.stringify(
      { asset: assetReceipt, routes: routes.slice(0, 100) },
      null,
      2,
    ),
  );
  const imports = [
    ...new Set(
      [
        ...content.matchAll(
          /from["'](\.\/(?:useSearchFlight|ModalsOfSearchFlightForm|msw)-[^"']+\.js)["']/g,
        ),
      ].map((m) => new URL(m[1], appUrls[0]).href),
    ),
  ];
  for (const target of imports) {
    const r = await fetch(target, {
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`Declared asset unavailable: HTTP ${r.status}`);
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length > 10000000) throw new Error('Declared asset exceeds limit');
    const name = path.basename(new URL(target).pathname);
    await fs.writeFile(path.join(root, name), body);
    const snippets = [
      ...body
        .toString('utf8')
        .matchAll(
          /.{0,180}(?:fetch\(|flight_search|recaptchaV3Token|recaptchaToken|searchFlight:|flightSearchParameters).{0,240}/g,
        ),
    ].map((m) => m[0]);
    console.log(
      JSON.stringify(
        { file: name, bytes: body.length, snippets: snippets.slice(0, 25) },
        null,
        2,
      ),
    );
  }
}
