/** Targeted continuation of the saved 167 unresolved records. Original catalogues stay immutable. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { getCACertificates } from 'node:tls';
import { taipeiDate } from '../../src/lib/time';
import {
  normalizeCollected,
  type SavedFlight,
} from '../../src/server/providers/collected';
import {
  verificationKey,
  verificationFingerprint,
  type VerificationLedger,
} from '../../src/server/services/timetable-verification';
import {
  buildGroups,
  sha,
  assertSourceURL,
  sourceVerifier,
  type Download,
} from './sources';
import { fetchPublicSession } from './public-session';
import { compareObservation, markPending } from './compare';
import { readSourceStops, saveSourceStop } from './source-stops';
const read = async (file: string) =>
  JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const atomic = async (file: string, value: unknown) => {
  const temp = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
  await fs.rename(temp, file);
};
class SourceStopped extends Error {}
async function main() {
  const args = process.argv.slice(2),
    python = args[args.indexOf('--python') + 1];
  assert.ok(args.includes('--python'));
  const trusted = new Set(getCACertificates('default'));
  assert.ok(
    getCACertificates('system').every((c) => trusted.has(c)),
    'Start node --use-system-ca --import tsx',
  );
  const today = taipeiDate();
  assert.ok(today <= '2026-12-31');
  const base = path.resolve('data/automatic-verification'),
    baseline = await read(path.join(base, 'runs/2026-10-14/progress.json')),
    root = path.join(base, 'focused', today + '-pending167');
  const max = Number(
    args.includes('--max-groups')
      ? args[args.indexOf('--max-groups') + 1]
      : 200,
  );
  assert.ok(Number.isInteger(max) && max > 0 && max <= 200);
  const all: SavedFlight[] = [];
  for (const [file, digest] of Object.entries(baseline.originals)) {
    const bytes = await fs.readFile(file);
    assert.equal(sha(bytes), digest, `Original catalogue changed: ${file}`);
    if (
      file.endsWith('-flights.json') &&
      !file.endsWith('collected-flights.json')
    )
      all.push(
        ...JSON.parse(bytes.toString('utf8')).records.filter(
          (r: SavedFlight) =>
            r.date >= baseline.from && r.date <= baseline.through,
        ),
      );
  }
  for (const r of all) normalizeCollected(r);
  const anchorLedger = await read(
    path.join(base, 'focused/pending167-anchor.json'),
  ).catch((e) => {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return null;
  });
  const current = (await read(
    path.join(base, 'latest.json'),
  )) as VerificationLedger;
  const targetKeys =
    anchorLedger?.keys ||
    all
      .filter(
        (r) =>
          ['collected_vietnam', 'collected_eva'].includes(r.kind) &&
          current.entries[verificationKey(r)]?.state !== 'verified',
      )
      .map(verificationKey)
      .sort();
  assert.equal(targetKeys.length, 167);
  assert.equal(new Set(targetKeys).size, 167);
  const target = all.filter((r) => targetKeys.includes(verificationKey(r)));
  assert.equal(target.length, 167);
  assert.equal(target.filter((r) => r.kind === 'collected_eva').length, 1);
  assert.equal(
    target.filter((r) => r.kind === 'collected_vietnam').length,
    166,
  );
  const groups = buildGroups(target, { evaPublicForm: true, from: today });
  if (args.includes('--plan')) {
    console.log(
      JSON.stringify({
        today,
        targets: target.length,
        groups: groups.length,
        byAirline: { BR: 1, VN: 166 },
        root,
      }),
    );
    return;
  }
  await fs.mkdir(root, { recursive: true });
  const lock = await fs.open(path.join(base, 'run.lock'), 'wx');
  await lock.writeFile(
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      scope: 'pending167',
    }),
  );
  try {
    if (!anchorLedger)
      await fs.writeFile(
        path.join(base, 'focused/pending167-anchor.json'),
        JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            scopeFrom: baseline.from,
            through: baseline.through,
            keys: targetKeys,
          },
          null,
          2,
        ),
        { flag: 'wx' },
      );
    const ledger = (await read(
      path.join(base, 'latest.json'),
    )) as VerificationLedger;
    let progress: any;
    try {
      progress = await read(path.join(root, 'progress.json'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (!progress) {
      progress = {
        version: 1,
        state: 'running',
        date: today,
        targetKeys,
        originals: baseline.originals,
        groupIDs: groups.map((g) => g.id),
        completed: {},
        blockedHosts: await readSourceStops(base, today),
        createdAt: new Date().toISOString(),
      };
      await fs.writeFile(
        path.join(root, 'before-ledger.json'),
        JSON.stringify(ledger, null, 2),
        { flag: 'wx' },
      );
      await atomic(path.join(root, 'progress.json'), progress);
    }
    assert.deepEqual(progress.targetKeys, targetKeys);
    assert.deepEqual(progress.originals, baseline.originals);
    assert.deepEqual(
      progress.groupIDs,
      groups.map((g) => g.id),
    );
    progress.blockedHosts = {
      ...progress.blockedHosts,
      ...(await readSourceStops(base, today)),
    };
    const cookies = new Map<string, string>();
    let lastRequest = 0,
      requests = 0;
    const download: Download = async (url, id, options = {}) => {
      const endpoint = assertSourceURL(url),
        stem = path.join(root, id);
      if (progress.blockedHosts[endpoint.host])
        throw new SourceStopped(
          'Source already stopped today; no repeated request',
        );
      try {
        const receipt = await read(stem + '.receipt.json'),
          body = await fs.readFile(stem + '.body');
        assert.equal(receipt.url, url);
        assert.equal(sha(body), receipt.sha256);
        if (receipt.status !== 200)
          throw new SourceStopped(`Saved HTTP ${receipt.status}; no repeat`);
        return { body, url, at: receipt.fetchedAt, file: stem + '.body' };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      try {
        await fs.access(stem + '.started.json');
        throw new SourceStopped(
          'Interrupted request; do not automatically repeat',
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      await atomic(stem + '.started.json', {
        url,
        method: options.method || 'GET',
        startedAt: new Date().toISOString(),
        scope: 'saved_pending167',
        ...(options.body && { bodySha256: sha(options.body.toString()) }),
      });
      await delay(Math.max(0, 1500 - (Date.now() - lastRequest)));
      lastRequest = Date.now();
      requests++;
      try {
        const response = await fetchPublicSession(
          url,
          {
            method: options.method || 'GET',
            body: options.body,
            headers: {
              accept: '*/*',
              ...(options.body && {
                'content-type': 'application/x-www-form-urlencoded',
              }),
              ...options.headers,
            },
          },
          cookies,
          async () => {
            throw new SourceStopped('Unexpected redirect');
          },
        );
        const reader = response.body?.getReader(),
          chunks: Uint8Array[] = [];
        let size = 0;
        if (reader)
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > 4_000_000) {
              await reader.cancel();
              throw new SourceStopped('Source body exceeds limit');
            }
            chunks.push(chunk.value);
          }
        const body = Buffer.concat(chunks),
          at = new Date().toISOString();
        await fs.writeFile(stem + '.body', body, { flag: 'wx' });
        await atomic(stem + '.receipt.json', {
          url,
          status: response.status,
          method: options.method || 'GET',
          fetchedAt: at,
          sha256: sha(body),
          bytes: size,
          location: response.headers.get('location'),
          authenticated: false,
          cookiesPersisted: false,
        });
        if (response.status !== 200)
          throw new SourceStopped(
            `HTTP ${response.status}; ${body
              .toString('utf8')
              .replace(/<[^>]+>/g, ' ')
              .slice(0, 240)}`,
          );
        return { body, url, at, file: stem + '.body' };
      } catch (e) {
        throw e instanceof SourceStopped
          ? e
          : new SourceStopped(
              [
                (e as Error).message,
                (e as any).cause?.code,
                (e as any).cause?.message,
              ]
                .filter(Boolean)
                .join(': '),
            );
      }
    };
    const verify = sourceVerifier(python, download, baseline.from),
      known = new Set(all.map(verificationKey));
    let count = 0;
    const checkpoint = async () => {
      const values = target.map((r) => ledger.entries[verificationKey(r)]);
      progress.summary = {
        targets: 167,
        verified: values.filter((e) => e?.state === 'verified').length,
        changed: values.filter((e) => e?.state === 'changed').length,
        notListed: values.filter((e) => e?.state === 'not_listed').length,
        failedOrNeedsReview: values.filter(
          (e) => !e || ['query_failed', 'needs_review'].includes(e.state),
        ).length,
        requestsThisRun: requests,
      };
      for (const [file, digest] of Object.entries(baseline.originals))
        assert.equal(sha(await fs.readFile(file)), digest);
      ledger.updatedAt = new Date().toISOString();
      await atomic(path.join(base, 'latest.json'), ledger);
      progress.savedAt = ledger.updatedAt;
      await atomic(path.join(root, 'progress.json'), progress);
    };
    for (const group of groups) {
      if (progress.completed[group.id]) continue;
      if (count >= max) break;
      const outstanding = group.records.filter(
        (r) => ledger.entries[verificationKey(r)]?.state !== 'verified',
      );
      if (!outstanding.length) {
        progress.completed[group.id] = {
          state: 'already_verified',
          records: group.records.length,
        };
        continue;
      }
      const host = new URL(group.url).host;
      if (progress.blockedHosts[host]) {
        const stop = progress.blockedHosts[host];
        markPending(
          outstanding,
          ledger,
          stop.at,
          '本次來源無法正常存取，未重複請求；目前為先前保存的班表。' +
            stop.reason,
          'query_failed',
          stop.file,
        );
        progress.completed[group.id] = {
          state: 'not_queried_source_unavailable',
          records: group.records.length,
          host,
        };
        await checkpoint();
        continue;
      }
      count++;
      try {
        const result = await verify({ ...group, records: outstanding }),
          compared = compareObservation(
            outstanding,
            result.rows,
            result.evidence.at,
            result.evidence.file,
            ledger,
            known,
          );
        await atomic(path.join(root, group.id + '.comparison.json'), {
          kind: group.kind,
          scope: result.scope,
          compared,
          observations: result.rows,
          at: result.evidence.at,
          evidenceFile: result.evidence.file,
        });
        progress.completed[group.id] = {
          state: 'compared',
          records: group.records.length,
          verified: compared.verified,
          changed: compared.changed,
          notListed: compared.not_listed,
        };
        console.log(
          JSON.stringify({
            kind: group.kind,
            date:
              group.queryDate ||
              new URL(group.url).searchParams.get('departureDate'),
            airport: group.airport,
            verified: compared.verified,
            changed: compared.changed,
            notListed: compared.not_listed,
            completed: Object.keys(progress.completed).length,
            total: groups.length,
          }),
        );
      } catch (e) {
        const at = new Date().toISOString(),
          reason = (e as Error).message,
          file = path.join(root, group.id + '.pending.json');
        await atomic(file, { at, reason, kind: group.kind, url: group.url });
        markPending(
          outstanding,
          ledger,
          at,
          reason,
          e instanceof SourceStopped ? 'query_failed' : 'needs_review',
          file,
        );
        progress.completed[group.id] = {
          state: 'pending',
          records: group.records.length,
          reason,
        };
        if (e instanceof SourceStopped) {
          progress.blockedHosts[host] = { at, reason, file };
          await saveSourceStop(base, today, host, { at, reason, file });
        }
        console.log(
          JSON.stringify({
            kind: group.kind,
            pending: group.id,
            reason,
            sourceStopped: e instanceof SourceStopped,
          }),
        );
      }
      await checkpoint();
    }
    progress.state =
      Object.keys(progress.completed).length === groups.length
        ? 'completed_available_sources_with_pending'
        : 'batch_saved';
    await checkpoint();
    // Successful rows outside this anchor must be bit-for-bit preserved in the ledger.
    const before = await read(path.join(root, 'before-ledger.json'));
    for (const [key, value] of Object.entries(before.entries)) {
      if (!targetKeys.includes(key))
        assert.deepEqual(
          ledger.entries[key],
          value,
          `Unrelated verification overwritten: ${key}`,
        );
    }
    assert.ok(
      target.every(
        (r) =>
          ledger.entries[verificationKey(r)]?.fingerprint ===
          verificationFingerprint(r),
      ),
    );
    console.log(
      JSON.stringify({
        root,
        state: progress.state,
        ...progress.summary,
        originalFilesUnchanged: 11,
      }),
    );
  } finally {
    await lock.close();
    await fs.unlink(path.join(base, 'run.lock'));
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
