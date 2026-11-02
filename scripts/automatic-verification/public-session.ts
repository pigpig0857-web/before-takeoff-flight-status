import assert from 'node:assert/strict';
export function updateAnonymousCookies(
  response: Response,
  host: string,
  cookies: Map<string, string>,
) {
  if (!['www.jejuair.net', 'booking.evaair.com'].includes(host)) return false;
  const jar = new Map(
    (cookies.get(host) || '')
      .split('; ')
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf('=');
        return [c.slice(0, i), c.slice(i + 1)];
      }),
  );
  let changed = false;
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(';')[0],
      i = pair.indexOf('=');
    if (i <= 0) continue;
    const key = pair.slice(0, i),
      value = pair.slice(i + 1);
    changed ||= jar.get(key) !== value;
    jar.set(key, value);
  }
  if (jar.size)
    cookies.set(host, [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
  return changed;
}
export async function fetchPublicSession(
  url: string,
  options: RequestInit,
  cookies: Map<string, string>,
  onRedirect: (response: Response, hop: number) => Promise<void>,
  request: typeof fetch = fetch,
) {
  const target = new URL(url);
  const bootstrap =
    target.href ===
      'https://www.jejuair.net/en/prepare/flight/viewScheduleInfo.do' &&
    (!options.method || options.method === 'GET');
  for (let hop = 0; hop < 3; hop++) {
    const response = await request(url, {
      ...options,
      redirect: 'manual',
      signal: AbortSignal.timeout(25000),
      headers: {
        ...options.headers,
        ...(cookies.has(target.host) && { cookie: cookies.get(target.host)! }),
      },
    });
    const changed = updateAnonymousCookies(response, target.host, cookies);
    const location = response.headers.get('location'),
      next = location ? new URL(location, url) : null;
    if (
      bootstrap &&
      response.status === 302 &&
      next?.href === url &&
      changed &&
      hop < 2
    ) {
      await onRedirect(response, hop);
      continue;
    }
    if (bootstrap && response.status === 200) {
      const html = await response.clone().text();
      assert.ok(
        !/access denied|verify you are human|<title>[^<]*captcha/i.test(html),
        'Source challenge page; stop without bypass',
      );
    }
    return response;
  }
  throw new Error('Public session did not complete');
}
