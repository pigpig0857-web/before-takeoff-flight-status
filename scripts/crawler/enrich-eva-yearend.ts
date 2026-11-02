import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEvaDetail } from './eva-detail';
import type { CollectedSnapshot } from '../../src/server/providers/collected';

async function main() {
  const args = process.argv.slice(2);
  const python = args[args.indexOf('--python') + 1];
  assert.ok(args.includes('--python') && python, '--python required');
  const root = path.resolve('data/source-samples/crawler/eva-yearend-2026');
  const directory = path.join(root, 'full-details');
  await fs.mkdir(directory, { recursive: true });
  const lock = await fs.open(path.join(directory, 'run.lock'), 'wx');
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  const plan = JSON.parse(
    await fs.readFile(path.join(root, 'progress.json'), 'utf8'),
  );
  const snapshot: CollectedSnapshot = JSON.parse(
    await fs.readFile('src/server/data/eva-flights.json', 'utf8'),
  );
  const samples = JSON.parse(
    await fs.readFile(
      path.join(root, 'detail-crosschecks/manifest.json'),
      'utf8',
    ),
  );
  const entries: any[] = [];
  const cookies = new Map<string, string>();
  let lastRequest = 0,
    requests = 0;
  const save = async (filename: string, value: unknown) => {
    await fs.writeFile(
      path.join(directory, filename) + '.tmp',
      JSON.stringify(value, null, 2),
    );
    await fs.rename(
      path.join(directory, filename) + '.tmp',
      path.join(directory, filename),
    );
  };
  const summary = () => ({
    updatedAt: new Date().toISOString(),
    total: snapshot.records.length,
    checked: entries.filter((e) => e.status === 'verified').length,
    failed: entries.filter((e) => e.status === 'failed').length,
    pending: snapshot.records.length - entries.length,
    requests,
    scope: '2026-10-08 through 2026-12-31, TPE BR nonstop segments',
    allPublishedFlightsGuaranteed: false,
  });
  const request = async (url: string, filename: string) => {
    const target = new URL(url);
    assert.equal(target.origin, 'https://booking.evaair.com');
    assert.ok(
      [
        '/flyeva/eva/b2c/flight-schedules.aspx',
        '/flyeva/eva/b2c/flight-details.aspx',
      ].includes(target.pathname.toLowerCase()),
    );
    await delay(Math.max(0, 1500 - (Date.now() - lastRequest)));
    lastRequest = Date.now();
    requests++;
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
      headers: {
        'User-Agent':
          'FlightStatusResearch/0.1 (public flight detail verification)',
        Accept: 'text/html',
        Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
    });
    assert.equal(
      response.status,
      200,
      `HTTP ${response.status}; stopped without following redirects`,
    );
    for (const item of response.headers.getSetCookie()) {
      const pair = item.split(';')[0],
        i = pair.indexOf('=');
      if (i > 0) cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const raw = Buffer.from(await response.arrayBuffer());
    assert.ok(raw.length > 0 && raw.length < 2000000, 'Invalid source size');
    const receipt = {
      url,
      httpStatus: response.status,
      observedAt: new Date().toISOString(),
      sha256: createHash('sha256').update(raw).digest('hex'),
    };
    await fs.writeFile(path.join(directory, filename), raw);
    await save(filename + '.receipt.json', receipt);
    return raw;
  };
  try {
    // Read source once for the normal anonymous session; do not follow access refusals.
    await request(plan.sourceUrl, `session-${Date.now()}.html`);
    const observations = new Map(
      plan.routes.flatMap((route: any) =>
        route.records.map((r: any) => [
          `${r.airport}|${r.date}|${r.number}`,
          r,
        ]),
      ),
    );
    for (const record of snapshot.records) {
      const file = `${record.airport}-${record.date}-${record.number}.html`;
      const entry: any = {
        airport: record.airport,
        number: record.number,
        date: record.date,
        file,
        status: 'pending',
      };
      try {
        const observation: any = observations.get(
          `${record.airport}|${record.date}|${record.number}`,
        );
        assert.ok(observation, 'Missing table evidence');
        const sample = samples.find(
          (s: any) =>
            s.airport === record.airport && s.status.startsWith('verified'),
        );
        assert.ok(sample, 'Missing audited airport label');
        let sourceDir = directory,
          raw: Buffer;
        try {
          raw = await fs.readFile(path.join(directory, file));
        } catch (e: any) {
          if (e.code !== 'ENOENT') throw e;
          try {
            raw = await fs.readFile(
              path.join(root, 'detail-crosschecks', file),
            );
            sourceDir = path.join(root, 'detail-crosschecks');
          } catch (cached: any) {
            if (cached.code !== 'ENOENT') throw cached;
            raw = await request(observation.detailLink, file);
          }
        }
        const receipt = JSON.parse(
          await fs.readFile(
            path.join(sourceDir, file + '.receipt.json'),
            'utf8',
          ),
        );
        assert.equal(receipt.httpStatus, 200);
        assert.equal(receipt.url, observation.detailLink);
        assert.equal(
          receipt.sha256,
          createHash('sha256').update(raw).digest('hex'),
        );
        const parsed = JSON.parse(
          execFileSync(
            python,
            [
              'scripts/crawler/fetch-eva-form.py',
              '--parse-detail-file',
              path.join(sourceDir, file),
            ],
            { encoding: 'utf8', timeout: 10000, maxBuffer: 1000000 },
          ),
        );
        const detail = parseEvaDetail(parsed.detailText, {
          ...observation,
          minutes: record.minutes,
          arrivalLabel: sample.arrivalLabel,
        });
        entry.status = 'verified';
        entry.evidence = {
          ...detail,
          url: receipt.url,
          fetchedAt: receipt.observedAt,
        };
        entry.evidenceFile = path.relative(root, path.join(sourceDir, file));
        entry.sha256 = receipt.sha256;
      } catch (e: any) {
        entry.status = 'failed';
        entry.error = e.message;
        entries.push(entry);
        await save('manifest.json', entries);
        await save('summary.json', summary());
        // Access refusal stops the run; content mismatches are quarantined per flight.
        if (/HTTP \d+|fetch failed|timeout|aborted/i.test(e.message)) throw e;
        continue;
      }
      entries.push(entry);
      if (entries.length % 20 === 0) {
        await save('manifest.json', entries);
        await save('summary.json', summary());
        console.log(JSON.stringify(summary()));
      }
    }
    await save('manifest.json', entries);
    await save('summary.json', summary());
    console.log(JSON.stringify(summary()));
  } finally {
    await lock.close();
    await fs.unlink(path.join(directory, 'run.lock'));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
