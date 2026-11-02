import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareUpdate, inspectUpdate } from './store';
import {
  peachCandidate,
  evaCandidate,
  type PeachReceipt,
  type PeachExtraction,
  type EvaReceipt,
} from './sources';
import type { Airline } from './compare';
import type {
  EvaWeek,
  EvaDetail,
} from '../../src/server/providers/experimental/eva-schedule';
import { validDate } from '../../src/lib/time';

const execute = promisify(execFile);
const sha = (body: Buffer | string) =>
  createHash('sha256').update(body).digest('hex');
const encode = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
async function json(file: string) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function atomic(file: string, v: unknown) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(tmp, encode(v), { flag: 'wx' });
  await fs.rename(tmp, file);
}
function inside(root: string, file: string) {
  const rel = path.relative(root, file);
  assert.ok(
    rel && !rel.startsWith('..') && !path.isAbsolute(rel),
    'Refresh path outside workspace',
  );
}
async function hashes(workspace: string) {
  const names = [
    'eva-flights.json',
    'peach-flights.json',
    'peach-booking-checks.json',
    'peach-verification-progress.json',
  ];
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        sha(await fs.readFile(path.join(workspace, 'src/server/data', name))),
      ]),
    ),
  );
}
async function command(
  workspace: string,
  bin: string,
  args: string[],
  log: string,
  timeout = 180000,
) {
  try {
    const r = await execute(bin, args, {
      cwd: workspace,
      encoding: 'utf8',
      timeout,
      maxBuffer: 4000000,
      windowsHide: true,
    });
    await fs.writeFile(log, r.stdout + '\n' + r.stderr);
  } catch (e: any) {
    await fs.writeFile(
      log,
      (e.stdout || '') + '\n' + (e.stderr || '') + '\n' + String(e.message),
    );
    throw new Error(`Source step failed; see ${path.relative(workspace, log)}`);
  }
}
interface Job {
  version: 1;
  airline: Airline;
  from: string;
  through: '2026-12-31';
  state: string;
  step: string;
  createdAt: string;
  sourceDirectory: string;
  queryDate?: string;
  arrival?: string;
  sourceWasAlreadySaved: boolean;
  baselineHashes: Record<string, string>;
  candidateCreatedAt?: string;
  updateRun?: string;
  candidateSha256?: string;
  error?: string;
  filesUnchanged?: boolean;
  completedAt?: string;
}
export interface RefreshOptions {
  airline?: Airline;
  from?: string;
  python: string;
  sourceDirectory?: string;
  resume?: string;
  queryDate?: string;
  arrival?: string;
}
/** Network collection is bounded and optional; replay/prepare never replaces the live catalogue. */
export async function refreshSchedules(
  workspace: string,
  options: RefreshOptions,
) {
  workspace = await fs.realpath(path.resolve(workspace));
  const base = path.join(workspace, 'data/source-samples/crawler');
  let root: string, job: Job;
  if (options.resume) {
    root = await fs.realpath(path.resolve(workspace, options.resume));
    inside(base, root);
    job = await json(path.join(root, 'progress.json'));
    assert.equal(job.version, 1);
    assert.ok(['eva', 'peach'].includes(job.airline));
  } else {
    assert.ok(options.airline && ['eva', 'peach'].includes(options.airline));
    assert.ok(
      options.from && validDate(options.from) && options.from <= '2026-12-31',
    );
    if (options.airline === 'eva' && !options.sourceDirectory) {
      assert.ok(
        options.queryDate &&
          validDate(options.queryDate) &&
          options.queryDate >= options.from &&
          options.queryDate <= '2026-12-31',
      );
      assert.ok(
        ['NRT', 'ICN', 'BKK', 'SFO'].includes(options.arrival || ''),
        'Unreviewed refresh route',
      );
    }
    await fs.mkdir(base, { recursive: true });
    root = path.join(
      base,
      `refresh-${options.airline}-${Date.now()}-${randomUUID().slice(0, 8)}`,
    );
    await fs.mkdir(root);
    const source = options.sourceDirectory
      ? await fs.realpath(path.resolve(workspace, options.sourceDirectory))
      : path.join(root, 'sources');
    inside(base, source);
    job = {
      version: 1,
      airline: options.airline,
      from: options.from,
      through: '2026-12-31',
      state: 'running',
      step: options.sourceDirectory ? 'replay' : 'collect',
      createdAt: new Date().toISOString(),
      sourceDirectory: path.relative(workspace, source),
      queryDate: options.queryDate,
      arrival: options.arrival,
      sourceWasAlreadySaved: !!options.sourceDirectory,
      baselineHashes: await hashes(workspace),
    };
    await atomic(path.join(root, 'progress.json'), job);
  }
  const stateFile = path.join(root, 'progress.json');
  const source = path.resolve(workspace, job.sourceDirectory);
  inside(base, source);
  const lock = await fs.open(path.join(root, 'refresh.lock'), 'wx');
  await lock.writeFile(
    encode({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  const save = () => atomic(stateFile, job);
  try {
    if (job.state === 'prepared')
      return {
        root,
        job,
        update: await inspectUpdate(workspace, job.updateRun!),
      };
    if (job.state === 'pending_confirmation') return { root, job }; // No repeated request after source denial.
    assert.equal(job.state, 'running');
    if (job.step === 'collect') {
      let receipt;
      try {
        receipt = await json(path.join(source, 'receipt.json'));
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }
      if (!receipt) {
        // If a previous process created an incomplete source directory, do not recreate it.
        try {
          await fs.access(source);
          throw new Error(
            'Interrupted source collection; retain it for confirmation',
          );
        } catch (e: any) {
          if (e.code !== 'ENOENT') throw e;
        }
        const args =
          job.airline === 'peach'
            ? [
                'scripts/crawler/collect-peach.mjs',
                '--from',
                job.from,
                '--output-dir',
                source,
              ]
            : [
                'scripts/crawler/fetch-eva-form-node.mjs',
                '--date',
                job.queryDate!,
                '--arrival',
                job.arrival!,
                '--collect-details',
                '--python',
                options.python,
                '--output-dir',
                source,
              ];
        await command(
          workspace,
          process.execPath,
          args,
          path.join(root, 'collector.log'),
        );
      }
      job.step = 'replay';
      await save();
    }
    const realSource = await fs.realpath(source);
    inside(base, realSource);
    const receipt = await json(path.join(source, 'receipt.json'));
    const fileSha256: Record<string, string> = {};
    async function evidence(relative: string, expected?: string) {
      const file = await fs.realpath(path.join(source, relative));
      inside(realSource, file);
      const digest = sha(await fs.readFile(file));
      if (expected)
        assert.equal(digest, expected, 'Source raw evidence hash mismatch');
      fileSha256[path.relative(workspace, file)] = digest;
    }
    await evidence('receipt.json');
    job.candidateCreatedAt ||= new Date().toISOString();
    await save();
    let result;
    if (job.airline === 'peach') {
      const p = receipt as PeachReceipt;
      assert.equal(p.status, 'downloaded');
      assert.equal(p.requestedFrom, job.from);
      assert.equal(p.requestedTo, job.through);
      await evidence('source-index.html', p.indexSha256);
      assert.equal(p.sources.length, 2);
      for (const s of p.sources) {
        assert.ok(['summer.pdf', 'winter.pdf'].includes(s.file));
        await evidence(s.file, s.sha256);
      }
      const parsed = path.join(source, 'parsed');
      await command(
        workspace,
        options.python,
        [
          '-X',
          'utf8',
          'scripts/crawler/extract-peach.py',
          source,
          '--output-dir',
          parsed,
        ],
        path.join(root, 'replay.log'),
      );
      for (const f of ['flights.json', 'coverage.json', 'rules.json'])
        await evidence('parsed/' + f);
      result = peachCandidate(
        (await json(path.join(parsed, 'flights.json'))) as PeachExtraction,
        p,
        job.candidateCreatedAt,
      );
    } else {
      const p = receipt as EvaReceipt;
      assert.equal(p.status, 'verified_requested_scope');
      assert.equal(p.query.departure, 'TPE');
      assert.ok(p.query.date >= job.from && p.query.date <= job.through);
      assert.ok(p.requests.length >= 3);
      assert.equal(
        new Set(p.requests.map((r) => r.savedFile)).size,
        p.requests.length,
      );
      for (const r of p.requests) {
        assert.equal(r.httpStatus, 200);
        assert.equal(r.status, 'received');
        assert.match(r.savedFile, /^(form|search|detail-\d+)\.html$/);
        assert.match(r.sha256, /^[a-f0-9]{64}$/);
        await evidence(r.savedFile, r.sha256);
      }
      for (const f of ['week.json', 'details-manifest.json']) await evidence(f);
      const parsedTable = await execute(
        options.python,
        [
          '-X',
          'utf8',
          'scripts/crawler/fetch-eva-form.py',
          '--parse-file',
          path.join(source, 'search.html'),
        ],
        {
          cwd: workspace,
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 4000000,
          windowsHide: true,
        },
      );
      assert.deepEqual(
        (await json(path.join(source, 'week.json'))).rows,
        JSON.parse(parsedTable.stdout).rows,
        'Saved EVA table differs from raw official HTML',
      );
      await command(
        workspace,
        process.execPath,
        [
          'node_modules/tsx/dist/cli.mjs',
          'scripts/crawler/validate-eva-http.ts',
          '--sample-dir',
          source,
          '--date',
          p.query.date,
          '--arrival',
          p.query.arrival,
          '--python',
          options.python,
          '--mode',
          'validate',
        ],
        path.join(root, 'replay.log'),
      );
      await evidence('details.json');
      result = evaCandidate(
        (await json(path.join(source, 'week.json'))) as EvaWeek,
        (await json(path.join(source, 'details.json'))) as EvaDetail[],
        p,
        job.candidateCreatedAt,
      );
    }
    const candidateFile = path.join(root, 'candidate.json'),
      candidateText = encode(result.snapshot);
    await atomic(candidateFile, result.snapshot);
    const proofFile = path.join(root, 'source-verification.json');
    const proof = {
      version: 1,
      status: 'verified',
      airline: job.airline,
      verifiedAt: job.candidateCreatedAt,
      candidateSha256: sha(candidateText),
      scope: result.scope,
      fileSha256,
      records: result.snapshot.records.length,
      method:
        job.airline === 'peach'
          ? 'Official PDFs rehashed and replayed; seasonal date/route coverage validated'
          : 'Official raw HTML rehashed and replayed; all requested date details match table',
      allActualFlightsIndependentlyConfirmed: false,
      bookingEvidenceUpdated: false,
    };
    await atomic(proofFile, proof);
    assert.deepEqual(
      await hashes(workspace),
      job.baselineHashes,
      'Live data or booking evidence changed during refresh',
    );
    job.step = 'prepare';
    await save();
    // Recover a package made before a process stopped just before saving its final progress marker.
    const runs = path.join(workspace, 'data/flight-updates');
    let existing: string | undefined;
    for (const item of await fs
      .readdir(runs, { withFileTypes: true })
      .catch((e) => {
        if (e.code === 'ENOENT') return [];
        throw e;
      })) {
      if (!item.isDirectory()) continue;
      try {
        const p = await json(path.join(runs, item.name, 'progress.json'));
        if (
          p.state === 'prepared' &&
          p.sourceEvidence?.file === path.relative(workspace, proofFile) &&
          p.incomingSha256 === proof.candidateSha256 &&
          p.sourceEvidence.sha256 === sha(encode(proof))
        )
          existing = path.join(runs, item.name);
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    const update = existing
      ? await inspectUpdate(workspace, existing)
      : await prepareUpdate(workspace, job.airline, candidateFile, job.from, {
          scope: result.scope,
          evidenceFile: proofFile,
        });
    job.state = 'prepared';
    job.updateRun = existing || update.run;
    job.candidateSha256 = proof.candidateSha256;
    job.filesUnchanged = true;
    job.completedAt = new Date().toISOString();
    await save();
    return { root, job, update };
  } catch (e: any) {
    job.state = 'pending_confirmation';
    job.error = String(e.message);
    job.filesUnchanged =
      JSON.stringify(await hashes(workspace)) ===
      JSON.stringify(job.baselineHashes);
    await save();
    return { root, job };
  } finally {
    await lock.close();
    await fs.unlink(path.join(root, 'refresh.lock'));
  }
}
