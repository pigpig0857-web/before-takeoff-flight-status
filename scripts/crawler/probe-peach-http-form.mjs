/** Bounded public-page preflight. Never generates, omits, or replays a required verification token. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve(
  'data/source-samples/crawler',
  `peach-http-form-${Date.now()}`,
);
const sha = (body) => createHash('sha256').update(body).digest('hex');
const protectedFiles = [
  'src/server/data/peach-flights.json',
  'src/server/data/peach-booking-checks.json',
  'src/server/data/peach-verification-progress.json',
  'src/server/data/eva-flights.json',
];
const before = Object.fromEntries(
  await Promise.all(
    protectedFiles.map(async (file) => [file, sha(await fs.readFile(file))]),
  ),
);
const report = {
  startedAt: new Date().toISOString(),
  mode: 'ordinary_http_public_form_preflight',
  plannedQuery: { date: '2026-10-29', departure: 'TPE', arrival: 'OKA' },
  requests: [],
  flightQuerySubmitted: false,
  flightsCollected: 0,
  integratedIntoWebsite: false,
};
await fs.mkdir(root, { recursive: true });
const checkpoint = async () =>
  fs.writeFile(
    path.join(root, 'receipt.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
async function get(url, file) {
  const u = new URL(url);
  if (u.origin !== 'https://booking.flypeach.com')
    throw new Error('Unreviewed source origin');
  const entry = {
    method: 'GET',
    url,
    file,
    startedAt: new Date().toISOString(),
  };
  report.requests.push(entry);
  await checkpoint();
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });
  entry.httpStatus = response.status;
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 2000000) throw new Error('Source exceeds 2 MB');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const body = Buffer.concat(chunks);
  entry.bytes = body.length;
  entry.sha256 = sha(body);
  entry.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, file), body);
  await checkpoint();
  if (response.status !== 200) {
    report.state =
      response.status === 403 ? 'access_denied' : 'source_unavailable';
    throw new Error(`Stopped HTTP ${response.status}; no redirect or retry`);
  }
  const text = body.toString('utf8');
  if (
    /<title[^>]*>\s*Access Denied|You don't have permission to access/i.test(
      text,
    )
  ) {
    report.state = 'access_denied';
    throw new Error('Source returned an access-denied page; stopped');
  }
  return text;
}
try {
  const html = await get('https://booking.flypeach.com/en/', 'index.html');
  const initializer = html.match(
    /<script[^>]*id=["']peach_data_initializer["'][^>]*>([\s\S]*?)<\/script>/,
  )?.[1];
  const encoded = initializer?.match(
    /decodeURIComponent\(("(?:[^"\\]|\\.)*")\)/,
  )?.[1];
  if (!encoded) throw new Error('Unrecognized initializer; no form submitted');
  const config = JSON.parse(decodeURIComponent(JSON.parse(encoded)));
  report.verification = {
    v3KeyConfigured:
      typeof config.recaptchaV3ApiKey === 'string' &&
      config.recaptchaV3ApiKey.length > 0,
    v2InvisibleRequired:
      config.needRecaptchaV2InvisibleForFlightSearch === true,
    ruCaptchaRequired: config.needRucaptcha === true,
  };
  const scriptUrls = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)]
    .map((m) => new URL(m[1], 'https://booking.flypeach.com/en/').href)
    .filter((url) =>
      /^https:\/\/booking\.flypeach\.com\/react\/assets\/flight-[\w-]+\.js$/.test(
        url,
      ),
    );
  if (new Set(scriptUrls).size !== 1)
    throw new Error('Unrecognized application asset; stopped');
  const appUrl = scriptUrls[0];
  const app = await get(appUrl, 'application.js');
  const imports = [
    ...app.matchAll(/from["'](\.\/useSearchFlight-[\w-]+\.js)["']/g),
  ].map((m) => new URL(m[1], appUrl).href);
  if (new Set(imports).size !== 1)
    throw new Error('Unrecognized form module; stopped');
  const form = await get(imports[0], 'search-form.js');
  report.formEvidence = {
    declaredSearchPath: '/en/search',
    flightSearchV3Verification: form.includes(
      'executeV3Verification("flight_search")',
    ),
    captchaField: form.includes('name:"captcha"'),
    verificationBeforeSubmit: /await \$\(T\)/.test(form),
  };
  if (Object.values(report.verification).some(Boolean)) {
    report.state = 'verification_required';
    report.reason =
      'Official page config enables search verification. Plain HTTP form submission was not attempted; no token generated, omitted, or replayed.';
  } else {
    report.state = 'requires_further_form_review';
    report.reason =
      'No configured verification detected; form construction still needs review before any flight query.';
  }
} catch (e) {
  report.state ||= 'preflight_failed';
  report.error = String(e.message).slice(0, 500);
} finally {
  const after = Object.fromEntries(
    await Promise.all(
      protectedFiles.map(async (file) => [file, sha(await fs.readFile(file))]),
    ),
  );
  report.protectedDataUnchanged = protectedFiles.every(
    (file) => before[file] === after[file],
  );
  report.protectedFileHashes = before;
  report.finishedAt = new Date().toISOString();
  await checkpoint();
  console.log(JSON.stringify({ root, ...report }, null, 2));
  if (!report.protectedDataUnchanged) process.exitCode = 1;
}
