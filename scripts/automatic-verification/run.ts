import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { taipeiDate } from '../../src/lib/time';
import {
  normalizeCollected,
  type CollectedSnapshot,
  type SavedFlight,
} from '../../src/server/providers/collected';
import type { VerificationLedger } from '../../src/server/services/timetable-verification';
import { verificationKey } from '../../src/server/services/timetable-verification';
import { compareObservation, markPending } from './compare';
import { fetchPublicSession } from './public-session';
import { readSourceStops, saveSourceStop } from './source-stops';
import { reuseFocusedResults } from './reuse-focused';
import { inspectRuntimeTrust } from './runtime-trust';
import {
  assertSourceURL,
  buildGroups,
  sourceVerifier,
  sha,
  type ResponseEvidence,
} from './sources';

const airlines = [
  'eva',
  'peach',
  'tigerair',
  'starlux',
  'jeju',
  'vietnam',
  'jta',
  'jetstar',
  'philippine',
  'kaohsiung',
  'kaohsiung-peach',
  'kaohsiung-jetstar',
  'kaohsiung-jeju',
  'kaohsiung-eva',
  'kaohsiung-vietnam',
  'thai-lion',
  'kaohsiung-thai-lion',
  'kaohsiung-expanded',
];
const args = process.argv.slice(2);
const arg = (key: string) =>
  args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const read = async (file: string) =>
  JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
async function atomic(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
  await fs.rename(temp, file);
}
class SourceFailure extends Error {
  constructor(
    message: string,
    public host: string,
    public stopHost: boolean,
  ) {
    super(message);
  }
}
async function main() {
  const from = taipeiDate();
  if (from > '2026-12-31') {
    console.log(
      JSON.stringify({ state: 'scope_expired', from, through: '2026-12-31' }),
    );
    return;
  }
  const base = path.resolve('data/automatic-verification');
  await fs.mkdir(base, { recursive: true });
  if (!args.includes('--plan') && !args.includes('--replay-pending')) {
    const runtime = inspectRuntimeTrust();
    const runtimeDir = path.join(base, 'runtime');
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(
      path.join(runtimeDir, `${randomUUID()}.json`),
      JSON.stringify({ at: new Date().toISOString(), ...runtime }, null, 2),
      { flag: 'wx' },
    );
    assert.ok(
      runtime.ready,
      'TLS runtime is not ready; no source requests issued. Use Node --use-system-ca --import tsx with certificate verification enabled.',
    );
  }
  const originals: Record<string, string> = {},
    rows: SavedFlight[] = [];
  for (const brand of airlines) {
    const file = `src/server/data/${brand}-flights.json`,
      bytes = await fs.readFile(file);
    originals[file] = sha(bytes);
    const snapshot = JSON.parse(bytes.toString('utf8')) as CollectedSnapshot;
    for (const row of snapshot.records.filter(
      (r) => r.date >= from && r.date <= '2026-12-31',
    )) {
      normalizeCollected(row);
      rows.push(row);
    }
  }
  for (const file of [
    'src/server/data/peach-booking-checks.json',
    'src/server/data/peach-verification-progress.json',
    'src/server/data/collected-flights.json',
  ])
    originals[file] = sha(await fs.readFile(file));
  const root = path.join(base, 'runs', from);
  let savedJob: any;
  try {
    savedJob = await read(path.join(root, 'progress.json'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const groups = buildGroups(rows, {
    evaPublicForm: !savedJob || savedJob.version >= 2,
    from,
  });
  const knownIdentities = new Set(rows.map(verificationKey));
  if (args.includes('--plan')) {
    console.log(
      JSON.stringify(
        {
          state: 'plan_only',
          from,
          through: '2026-12-31',
          records: rows.length,
          groups: groups.length,
          bySource: Object.fromEntries(
            [...new Set(groups.map((g) => g.kind))].map((kind) => [
              kind,
              {
                groups: groups.filter((g) => g.kind === kind).length,
                records: groups
                  .filter((g) => g.kind === kind)
                  .reduce((n, g) => n + g.records.length, 0),
              },
            ]),
          ),
        },
        null,
        2,
      ),
    );
    return;
  }
  const python = arg('--python');
  assert.ok(python, '--python PATH is required');
  const replay = args.includes('--replay-pending');
  const max = Number(arg('--max-groups') || 1000),
    maxMinutes = Number(arg('--max-minutes') || 15);
  assert.ok(
    Number.isInteger(max) &&
      max > 0 &&
      max <= 20000 &&
      maxMinutes > 0 &&
      maxMinutes <= 60,
  );
  await fs.mkdir(root, { recursive: true });
  const lock = await fs.open(path.join(base, 'run.lock'), 'wx');
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  try {
    let job: any = savedJob;
    if (!job) {
      job = {
        version: 2,
        state: 'running',
        from,
        through: '2026-12-31',
        createdAt: new Date().toISOString(),
        originals,
        groupIDs: groups.map((g) => g.id),
        completed: {},
        blockedHosts: await readSourceStops(base, from),
        records: rows.length,
        totalGroups: groups.length,
      };
      await atomic(path.join(root, 'progress.json'), job);
    }
    job.blockedHosts = {
      ...job.blockedHosts,
      ...(await readSourceStops(base, from)),
    };
    assert.deepEqual(
      job.originals,
      originals,
      'Catalogue changed since saved batch; review before resuming',
    );
    assert.deepEqual(
      job.groupIDs,
      groups.map((g) => g.id),
      'Saved scope differs',
    );
    let ledger: VerificationLedger;
    try {
      ledger = await read(path.join(base, 'latest.json'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      ledger = { version: 1, updatedAt: new Date().toISOString(), entries: {} };
    }
    assert.equal(ledger.version, 1);
    const focused = await reuseFocusedResults(base, from, groups, ledger);
    for (const [id, outcome] of Object.entries(focused))
      if (!job.completed[id]) job.completed[id] = outcome;
    const deadline = Date.now() + maxMinutes * 60000;
    const anonymousCookies = new Map<string, string>();
    let lastEvaRequest = 0;
    const download = async (
      url: string,
      id: string,
      options: any = {},
    ): Promise<ResponseEvidence> => {
      const target = assertSourceURL(url),
        stem = path.join(
          root,
          id === 'jeju-index' && !replay ? `${id}-${randomUUID()}` : id,
        );
      try {
        const receipt = await read(stem + '.receipt.json');
        const body = await fs.readFile(stem + '.body');
        assert.equal(receipt.url, url);
        assert.equal(sha(body), receipt.sha256);
        if (receipt.status !== 200)
          throw new SourceFailure(
            `Saved HTTP ${receipt.status}; no repeated request`,
            target.host,
            true,
          );
        return { body, at: receipt.fetchedAt, file: stem + '.body', url };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      // One official Tigerair response contains both departure airports. Reuse
      // a completed source from this date even when resuming another batch.
      if (
        url === 'https://api-cms.tigerairtw.com/api/flight-schedules/merge' ||
        url.startsWith('https://www.flypeach.com/application/files/') ||
        url.startsWith(
          'https://files.jetstar.com/api/public/content/gk_jq_timetable_',
        )
      ) {
        for (const [otherID, outcome] of Object.entries(job.completed) as [
          string,
          any,
        ][]) {
          if (
            ![
              'collected_tigerair',
              'collected_peach',
              'collected_jetstar',
            ].includes(outcome.kind) ||
            outcome.state !== 'compared'
          )
            continue;
          const comparison = await read(
            path.join(root, otherID + '.comparison.json'),
          );
          const source = comparison.evidenceFile as string;
          const receipt = await read(
            source.replace(/\.body$/, '.receipt.json'),
          );
          if (receipt.url !== url) continue;
          const body = await fs.readFile(source);
          assert.equal(receipt.url, url);
          assert.equal(receipt.status, 200);
          assert.equal(taipeiDate(new Date(receipt.fetchedAt)), from);
          assert.equal(sha(body), receipt.sha256);
          return { body, at: receipt.fetchedAt, file: source, url };
        }
      }
      try {
        await fs.access(stem + '.started.json');
        throw new SourceFailure(
          'Interrupted saved request; no automatic repeat',
          target.host,
          true,
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (replay)
        throw new Error('Offline replay cannot issue a new source request');
      await fs.writeFile(
        stem + '.started.json',
        JSON.stringify({
          url,
          method: options.method || 'GET',
          startedAt: new Date().toISOString(),
          authenticated: false,
        }),
        { flag: 'wx' },
      );
      try {
        if (target.host === 'booking.evaair.com') {
          await delay(Math.max(0, 1500 - (Date.now() - lastEvaRequest)));
          lastEvaRequest = Date.now();
        }
        const response = await fetchPublicSession(
          url,
          {
            redirect: 'manual',
            signal: AbortSignal.timeout(25000),
            method: options.method || 'GET',
            body: options.body,
            headers: {
              accept: '*/*',
              ...(options.body && {
                'content-type': 'application/x-www-form-urlencoded',
              }),
              ...(anonymousCookies.has(target.host) && {
                cookie: anonymousCookies.get(target.host)!,
              }),
              ...options.headers,
            },
          },
          anonymousCookies,
          async (response, hop) => {
            const bytes = Buffer.from(await response.arrayBuffer()),
              file = stem + `.session-${hop}.body`;
            await fs.writeFile(file, bytes, { flag: 'wx' });
            await fs.writeFile(
              file.replace(/\.body$/, '.receipt.json'),
              JSON.stringify({
                url,
                status: response.status,
                location: response.headers.get('location'),
                sha256: sha(bytes),
                fetchedAt: new Date().toISOString(),
                cookiesPersisted: false,
              }),
              { flag: 'wx' },
            );
          },
        );
        const reader = response.body?.getReader();
        assert.ok(reader, 'No response body');
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 10_000_000) {
            await reader.cancel();
            throw new Error('Source size exceeds limit');
          }
          chunks.push(part.value);
        }
        const body = Buffer.concat(chunks),
          at = new Date().toISOString();
        await fs.writeFile(stem + '.body', body, { flag: 'wx' });
        await fs.writeFile(
          stem + '.receipt.json',
          JSON.stringify(
            {
              url,
              method: options.method || 'GET',
              status: response.status,
              location: response.headers.get('location'),
              sha256: sha(body),
              fetchedAt: at,
              bytes: size,
              authenticated: false,
            },
            null,
            2,
          ),
          { flag: 'wx' },
        );
        if (response.status !== 200)
          throw new SourceFailure(
            `HTTP ${response.status}; source could not be confirmed`,
            target.host,
            true,
          );
        return { body, at, file: stem + '.body', url };
      } catch (e) {
        if (e instanceof SourceFailure) throw e;
        throw new SourceFailure(
          `Source request stopped: ${(e as Error).message}; ${(e as any).cause?.code || ''} ${(e as any).cause?.message || ''}`,
          target.host,
          true,
        );
      }
    };
    let initialKixBuild = '';
    for (const [id, outcome] of Object.entries(job.completed) as [
      string,
      any,
    ][]) {
      if (outcome.kind !== 'collected_kix' || outcome.state !== 'compared')
        continue;
      const receipt = await read(path.join(root, id + '.receipt.json'));
      const bytes = await fs.readFile(path.join(root, id + '.body'));
      assert.equal(sha(bytes), receipt.sha256);
      initialKixBuild =
        JSON.parse(bytes.toString('utf8')).find(
          (c: any) => c.command === 'update_build_id',
        )?.new || initialKixBuild;
    }
    const verify = sourceVerifier(python, download, from, initialKixBuild);
    let attempted = 0,
      skippedSinceCheckpoint = 0;
    for (const group of groups) {
      if (replay) {
        if (job.completed[group.id]?.state !== 'pending') continue;
        let savedReceipt;
        try {
          savedReceipt = await read(
            path.join(root, group.id + '.receipt.json'),
          );
        } catch {
          continue;
        }
        if (savedReceipt.status !== 200) continue;
        await fs.writeFile(
          path.join(root, group.id + `.prior-outcome-${randomUUID()}.json`),
          JSON.stringify(job.completed[group.id], null, 2),
          { flag: 'wx' },
        );
        delete job.completed[group.id];
      }
      if (job.completed[group.id]) continue;
      const host = new URL(group.url).host;
      // An access denial stops more requests to the same host for this daily run.
      if (job.blockedHosts[host]) {
        const failure = job.blockedHosts[host];
        markPending(
          group.records,
          ledger,
          failure.at,
          `同一來源本次已無法存取；未重複查詢，保留原班表。${failure.reason}`,
          'query_failed',
          failure.file,
        );
        job.completed[group.id] = {
          state: 'not_queried_source_unavailable',
          kind: group.kind,
          records: group.records.length,
        };
      } else {
        if (attempted >= max || Date.now() >= deadline) break;
        attempted++;
        try {
          const result = await verify(group);
          const compared = compareObservation(
            group.records,
            result.rows,
            result.evidence.at,
            result.evidence.file,
            ledger,
            knownIdentities,
          );
          await atomic(path.join(root, group.id + '.comparison.json'), {
            kind: group.kind,
            scope: result.scope,
            at: result.evidence.at,
            compared,
            observations: result.rows,
            evidenceFile: result.evidence.file,
          });
          job.completed[group.id] = {
            state: 'compared',
            kind: group.kind,
            records: group.records.length,
            verified: compared.verified,
            changed: compared.changed,
            notListed: compared.not_listed,
            added: compared.added.length,
          };
        } catch (e) {
          const at = new Date().toISOString(),
            reason = String((e as Error).message).slice(0, 800);
          const file = path.join(root, group.id + '.pending.json');
          await atomic(file, { at, reason, kind: group.kind, url: group.url });
          markPending(
            group.records,
            ledger,
            at,
            reason,
            e instanceof SourceFailure ? 'query_failed' : 'needs_review',
            file,
          );
          job.completed[group.id] = {
            state: 'pending',
            kind: group.kind,
            records: group.records.length,
            reason,
          };
          if (e instanceof SourceFailure && e.stopHost) {
            job.blockedHosts[e.host] = { at, reason, file };
            await saveSourceStop(base, from, e.host, { at, reason, file });
          }
        }
        await delay(500);
      }
      // Each completed group has durable evidence, outcomes and its own checkpoint.
      skippedSinceCheckpoint++;
      if (
        !job.blockedHosts[host] ||
        skippedSinceCheckpoint >= 100 ||
        attempted === 1
      ) {
        ledger.updatedAt = new Date().toISOString();
        await atomic(path.join(base, 'latest.json'), ledger);
        job.savedAt = ledger.updatedAt;
        await atomic(path.join(root, 'progress.json'), job);
        skippedSinceCheckpoint = 0;
      }
    }
    for (const [file, expected] of Object.entries(originals))
      assert.equal(
        sha(await fs.readFile(file)),
        expected,
        'Original catalogue/progress changed',
      );
    const outcomes = Object.values(job.completed) as any[];
    job.summary = {
      completedGroups: outcomes.length,
      totalGroups: groups.length,
      verifiedRows: outcomes.reduce((n, r) => n + (r.verified || 0), 0),
      changedRows: outcomes.reduce((n, r) => n + (r.changed || 0), 0),
      notListedRows: outcomes.reduce((n, r) => n + (r.notListed || 0), 0),
      pendingRows: outcomes
        .filter((r) => r.state !== 'compared')
        .reduce((n, r) => n + r.records, 0),
      additionalPublishedRows: outcomes.reduce((n, r) => n + (r.added || 0), 0),
      originalFilesUnchanged: Object.keys(originals).length,
    };
    job.state =
      outcomes.length !== groups.length
        ? 'batch_saved'
        : job.summary.pendingRows ||
            job.summary.changedRows ||
            job.summary.notListedRows
          ? 'completed_with_pending'
          : 'verified';
    job.savedAt = new Date().toISOString();
    await atomic(path.join(root, 'progress.json'), job);
    ledger.updatedAt = job.savedAt;
    await atomic(path.join(base, 'latest.json'), ledger);
    console.log(
      JSON.stringify(
        { state: job.state, from, through: job.through, ...job.summary },
        null,
        2,
      ),
    );
  } finally {
    await lock.close();
    await fs.unlink(path.join(base, 'run.lock'));
  }
}
main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
