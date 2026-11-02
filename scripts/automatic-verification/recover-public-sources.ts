/** Explicit recovery after fixing a source workflow. Prior outcomes and originals stay intact. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCACertificates } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { taipeiDate } from '../../src/lib/time';
import {
  normalizeCollected,
  type SavedFlight,
} from '../../src/server/providers/collected';
import {
  verificationKey,
  type VerificationLedger,
} from '../../src/server/services/timetable-verification';
import {
  buildGroups,
  sourceVerifier,
  sha,
  assertSourceURL,
  type Download,
} from './sources';
import { compareObservation, markPending } from './compare';
const args = process.argv.slice(2),
  arg = (key: string) =>
    args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const read = async (file: string) =>
  JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const atomic = async (file: string, value: unknown) => {
  const temp = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
  await fs.rename(temp, file);
};
class AccessStopped extends Error {}
async function main() {
  const trustedCAs = new Set(getCACertificates('default'));
  assert.ok(
    getCACertificates('system').every((c) => trustedCAs.has(c)),
    'System CAs missing in actual executing process; start node --use-system-ca --import tsx',
  );
  const kind = arg('--kind');
  assert.ok(kind === 'collected_vietnam' || kind === 'collected_jeju');
  const replay = args.includes('--replay-saved');
  assert.ok(
    !replay || kind === 'collected_vietnam',
    'Offline recovery currently supports Vietnam only',
  );
  const python = arg('--python');
  assert.ok(python);
  const from = taipeiDate(),
    base = path.resolve('data/automatic-verification'),
    daily = path.join(base, 'runs', from);
  const root = path.resolve(arg('--root') || '');
  assert.ok(root.startsWith(path.join(base, 'recovery') + path.sep));
  const max = Number(arg('--max-groups') || '200');
  assert.ok(Number.isInteger(max) && max > 0 && max <= 200);
  await fs.mkdir(root, { recursive: true });
  const lock = await fs.open(path.join(base, 'run.lock'), 'wx');
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  try {
    const dailyFile = path.join(daily, 'progress.json'),
      ledgerFile = path.join(base, 'latest.json');
    const job = await read(dailyFile),
      ledger = (await read(ledgerFile)) as VerificationLedger;
    const all: SavedFlight[] = [];
    for (const [file, digest] of Object.entries(job.originals)) {
      const bytes = await fs.readFile(file);
      assert.equal(sha(bytes), digest, `Catalogue changed: ${file}`);
      if (
        file.endsWith('-flights.json') &&
        !file.endsWith('collected-flights.json')
      ) {
        const snapshot = JSON.parse(bytes.toString('utf8'));
        for (const r of snapshot.records.filter(
          (r: SavedFlight) => r.date >= from && r.date <= job.through,
        )) {
          normalizeCollected(r);
          all.push(r);
        }
      }
    }
    const groups = buildGroups(all).filter((g) => g.kind === kind),
      known = new Set(all.map(verificationKey));
    let progress: any;
    try {
      progress = await read(path.join(root, 'progress.json'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (!progress) {
      progress = {
        version: 1,
        kind,
        from,
        through: job.through,
        originals: job.originals,
        groupIDs: groups.map((g) => g.id),
        completed: {},
        state: 'running',
        createdAt: new Date().toISOString(),
        workflowReason:
          kind === 'collected_vietnam'
            ? 'Use validated system CA; original attempt failed before this setting was applied'
            : 'Normal fresh anonymous session initialization; bounded same-origin cookie-setting redirect only',
      };
      await fs.writeFile(
        path.join(root, 'before-daily-progress.json'),
        JSON.stringify(job, null, 2),
        { flag: 'wx' },
      );
      await fs.writeFile(
        path.join(root, 'before-ledger.json'),
        JSON.stringify(ledger, null, 2),
        { flag: 'wx' },
      );
      await atomic(path.join(root, 'progress.json'), progress);
    }
    assert.deepEqual(progress.originals, job.originals);
    assert.deepEqual(
      progress.groupIDs,
      groups.map((g) => g.id),
    );
    if (progress.stopped && !replay) {
      console.log(
        JSON.stringify({
          state: 'stopped_no_repeat',
          reason: progress.stopped,
          completed: Object.keys(progress.completed).length,
        }),
      );
      return;
    }
    const cookies = new Map<string, string>();
    let jejuSession = false;
    const download: Download = async (url, id, options = {}) => {
      const target = assertSourceURL(url),
        stem = path.join(root, id),
        bootstrap = id === 'jeju-index';
      // A saved page cannot restore an anonymous session: pending POSTs need a fresh normal bootstrap.
      const sessionStem = bootstrap
        ? path.join(root, `jeju-session-${randomUUID()}`)
        : stem;
      if (!bootstrap) {
        try {
          const receipt = await read(stem + '.receipt.json'),
            body = await fs.readFile(stem + '.body');
          assert.equal(receipt.url, url);
          assert.equal(sha(body), receipt.sha256);
          if (receipt.status !== 200)
            throw new AccessStopped(`Saved HTTP ${receipt.status}; no repeat`);
          return { body, url, at: receipt.fetchedAt, file: stem + '.body' };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        if (kind === 'collected_vietnam' && arg('--seed')) {
          const seed = arg('--seed')!;
          const receipt = await read(seed + '.receipt.json');
          if (receipt.url === url) {
            const body = await fs.readFile(seed + '.body');
            assert.equal(receipt.status, 200);
            assert.equal(sha(body), receipt.sha256);
            await fs.writeFile(stem + '.body', body, { flag: 'wx' });
            await atomic(stem + '.receipt.json', {
              ...receipt,
              reusedEvidence: seed,
            });
            return { body, url, at: receipt.fetchedAt, file: stem + '.body' };
          }
        }
        if (replay) throw new Error('Offline replay cannot request a source');
        try {
          await fs.access(stem + '.started.json');
          throw new AccessStopped(
            'Interrupted request requires review; no automatic repeat',
          );
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }
      await atomic(sessionStem + '.started.json', {
        url,
        method: options.method || 'GET',
        startedAt: new Date().toISOString(),
      });
      let current = url;
      for (let hop = 0; hop < 3; hop++) {
        const response = await fetch(current, {
          redirect: 'manual',
          signal: AbortSignal.timeout(25000),
          method: options.method || 'GET',
          body: options.body,
          headers: {
            accept: '*/*',
            ...(options.body && {
              'content-type': 'application/x-www-form-urlencoded',
            }),
            ...(cookies.size &&
              target.host === 'www.jejuair.net' && {
                cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
              }),
            ...options.headers,
          },
        });
        let changedCookie = false;
        if (target.host === 'www.jejuair.net')
          for (const line of response.headers.getSetCookie()) {
            const pair = line.split(';')[0],
              i = pair.indexOf('=');
            if (i > 0) {
              const key = pair.slice(0, i),
                value = pair.slice(i + 1);
              changedCookie ||= cookies.get(key) !== value;
              cookies.set(key, value);
            }
          }
        const body = Buffer.from(await response.arrayBuffer());
        assert.ok(body.length <= 4_000_000);
        const at = new Date().toISOString(),
          file = (bootstrap ? sessionStem + `-${hop}` : stem) + '.body';
        await fs.writeFile(file, body, { flag: 'wx' });
        await atomic(file.replace(/\.body$/, '.receipt.json'), {
          url: current,
          method: options.method || 'GET',
          status: response.status,
          location: response.headers.get('location'),
          sha256: sha(body),
          fetchedAt: at,
          bytes: body.length,
          authenticated: false,
          cookiesPersisted: false,
        });
        if (response.status === 200) {
          if (bootstrap) {
            assert.ok(
              !/captcha|access denied|verify you are human/i.test(
                body.toString('utf8'),
              ),
              'Challenge page; stop source',
            );
            jejuSession = true;
          }
          return { body, at, file, url: current };
        }
        const location = response.headers.get('location'),
          next = location ? new URL(location, current) : null;
        // Only the public timetable's server-requested cookie/session handshake is followed.
        if (
          bootstrap &&
          response.status === 302 &&
          next?.href === url &&
          changedCookie &&
          hop < 2
        ) {
          await delay(500);
          current = next.href;
          continue;
        }
        throw new AccessStopped(
          `HTTP ${response.status}; source stopped without bypass or retry`,
        );
      }
      throw new AccessStopped('Anonymous session bootstrap did not complete');
    };
    const verify = sourceVerifier(python, download, from);
    let count = 0;
    const checkpoint = async () => {
      ledger.updatedAt = new Date().toISOString();
      await atomic(ledgerFile, ledger);
      const outcomes = Object.values(job.completed) as any[];
      job.summary = {
        ...job.summary,
        verifiedRows: outcomes.reduce((n, r) => n + (r.verified || 0), 0),
        changedRows: outcomes.reduce((n, r) => n + (r.changed || 0), 0),
        notListedRows: outcomes.reduce((n, r) => n + (r.notListed || 0), 0),
        pendingRows: outcomes
          .filter((r) => r.state !== 'compared')
          .reduce((n, r) => n + r.records, 0),
        additionalPublishedRows: outcomes.reduce(
          (n, r) => n + (r.added || 0),
          0,
        ),
      };
      job.state =
        job.summary.pendingRows ||
        job.summary.changedRows ||
        job.summary.notListedRows
          ? 'completed_with_pending'
          : 'verified';
      job.savedAt = ledger.updatedAt;
      await atomic(dailyFile, job);
      progress.savedAt = job.savedAt;
      await atomic(path.join(root, 'progress.json'), progress);
    };
    for (const group of groups) {
      if (replay) {
        if (progress.completed[group.id]?.state !== 'pending') continue;
        try {
          if (
            (await read(path.join(root, group.id + '.receipt.json'))).status !==
            200
          )
            continue;
        } catch {
          continue;
        }
        await atomic(
          path.join(
            root,
            group.id + '.prior-outcome-' + randomUUID() + '.json',
          ),
          progress.completed[group.id],
        );
      } else if (progress.completed[group.id]) continue;
      if (count >= max) break;
      count++;
      // Already verified records must never be downgraded or queried again.
      assert.ok(
        group.records.every(
          (r) => ledger.entries[verificationKey(r)]?.state !== 'verified',
        ),
        'Already verified recovery group',
      );
      try {
        const result = await verify(group),
          compared = compareObservation(
            group.records,
            result.rows,
            result.evidence.at,
            result.evidence.file,
            ledger,
            known,
          );
        await atomic(path.join(root, group.id + '.comparison.json'), {
          kind,
          scope: result.scope,
          at: result.evidence.at,
          compared,
          observations: result.rows,
          evidenceFile: result.evidence.file,
          priorOutcome: job.completed[group.id],
        });
        const outcome = {
          state: 'compared',
          kind,
          records: group.records.length,
          verified: compared.verified,
          changed: compared.changed,
          notListed: compared.not_listed,
          added: compared.added.length,
          recoveryEvidence: root,
        };
        progress.completed[group.id] = outcome;
        job.completed[group.id] = outcome;
        console.log(
          JSON.stringify({
            airport: group.airport,
            date:
              group.queryDate ||
              new URL(group.url).searchParams.get('departureDate'),
            verified: compared.verified,
            changed: compared.changed,
            notListed: compared.not_listed,
            added: compared.added.length,
            completed: Object.keys(progress.completed).length,
            total: groups.length,
          }),
        );
      } catch (e) {
        const at = new Date().toISOString(),
          reason = [
            (e as Error).message,
            (e as any).cause?.code,
            (e as any).cause?.message,
          ]
            .filter(Boolean)
            .join(': ')
            .slice(0, 800),
          file = path.join(root, group.id + '.pending.json');
        await atomic(file, {
          at,
          reason,
          url: group.url,
          kind,
          priorOutcome: job.completed[group.id],
        });
        markPending(
          group.records,
          ledger,
          at,
          reason,
          e instanceof AccessStopped ? 'query_failed' : 'needs_review',
          file,
        );
        progress.completed[group.id] = {
          state: 'pending',
          kind,
          records: group.records.length,
          reason,
        };
        job.completed[group.id] = progress.completed[group.id];
        // Network/denial and unknown session pages stop further source requests.
        if (
          e instanceof AccessStopped ||
          (e as any).cause ||
          /fetch failed|Challenge|bootstrap|timeout/i.test(reason)
        ) {
          progress.stopped = { at, reason };
        }
        console.log(
          JSON.stringify({
            pending: group.id,
            reason,
            stopped: !!progress.stopped,
          }),
        );
      }
      await checkpoint();
      if (progress.stopped && !replay) break;
      if (!replay) await delay(500);
    }
    for (const [file, digest] of Object.entries(job.originals))
      assert.equal(sha(await fs.readFile(file)), digest);
    progress.state = progress.stopped
      ? 'stopped_pending'
      : Object.keys(progress.completed).length === groups.length
        ? 'completed'
        : 'batch_saved';
    if (
      progress.state === 'completed' &&
      Object.values(progress.completed).every(
        (r: any) => r.state === 'compared',
      )
    ) {
      const host = new URL(groups[0].url).host;
      job.recoveredSources ??= [];
      if (!job.recoveredSources.some((r: any) => r.evidence === root))
        job.recoveredSources.push({
          host,
          at: new Date().toISOString(),
          priorBlock: job.blockedHosts[host],
          reason: progress.workflowReason,
          evidence: root,
        });
      delete job.blockedHosts[host];
    }
    await checkpoint();
    console.log(
      JSON.stringify({
        root,
        state: progress.state,
        groups: Object.keys(progress.completed).length,
        verified: job.summary.verifiedRows,
        pending: job.summary.pendingRows,
        jejuSession,
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
