/** Bounded foreground collection with durable progress; no background scheduler. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPlan,
  ingestVerifiedJob,
  summarize,
  splitUncoveredWindow,
  splitLargeJob,
} from './eva-coverage-state.mjs';
const args = process.argv.slice(2);
const option = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const directory = path.resolve(option('--run-dir') ?? '');
const root = path.resolve('data/source-samples/crawler');
const relative = path.relative(root, directory);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
  throw new Error('Invalid run directory');
const python = option('--python');
if (!python) throw new Error('--python required');
const read = async (file) =>
  JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'));
const save = async (file, value) => {
  const target = path.join(directory, file);
  await fs.writeFile(`${target}.tmp`, JSON.stringify(value, null, 2));
  await fs.rename(`${target}.tmp`, target);
};
await fs.mkdir(directory, { recursive: true });
const lockPath = path.join(directory, 'run.lock');
let lock;
try {
  lock = await fs.open(lockPath, 'wx');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const previous = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  if (!Number.isInteger(previous.pid) || previous.pid <= 0)
    throw new Error('Invalid lock; inspect it manually');
  try {
    process.kill(previous.pid, 0);
    throw new Error('Another collector is running');
  } catch (check) {
    if (check.code !== 'ESRCH') throw check;
  }
  await fs.unlink(lockPath);
  lock = await fs.open(lockPath, 'wx');
}
await lock.writeFile(
  JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
);
let plan;
try {
  if (args.includes('--init')) {
    try {
      await fs.access(path.join(directory, 'progress.json'));
      throw new Error('Progress already exists');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const catalog = JSON.parse(
      execFileSync(
        python,
        [
          'scripts/crawler/fetch-eva-form.py',
          '--parse-airports-file',
          path.join(directory, 'airports.xml'),
        ],
        { encoding: 'utf8', timeout: 10000 },
      ),
    ).airports;
    const bounds = JSON.parse(
      await fs.readFile(option('--bounds-receipt'), 'utf8'),
    );
    if (!bounds.publishedDateMin || !bounds.publishedDateMax)
      throw new Error('Missing published date bounds');
    plan = createPlan(
      bounds.publishedDateMin,
      bounds.publishedDateMax,
      catalog,
    );
    plan.boundsObservedAt = bounds.finishedAt;
    await save('progress.json', plan);
    console.log(JSON.stringify({ initialized: true, ...summarize(plan) }));
  } else {
    plan = await read('progress.json');
    if (args.includes('--refresh-catalog-status')) {
      const fresh = createPlan(plan.from, plan.through, plan.catalog);
      plan.catalog = plan.catalog.map((r) => ({
        ...r,
        status: fresh.catalog.find((c) => c.value === r.value).status,
      }));
      await save('progress.json', plan);
      console.log(JSON.stringify({ catalogStatusesRefreshed: true }));
    } else if (args.includes('--resize-pending')) {
      const arrival = option('--resize-pending');
      const size = Number(option('--days'));
      if (
        !plan.catalog.some(
          (r) => r.airport === arrival && r.status === 'reviewed_parser',
        ) ||
        !Number.isInteger(size) ||
        size < 1 ||
        size > 7
      )
        throw new Error('Invalid pending batch size');
      let changed = 0;
      for (const job of [...plan.jobs]) {
        if (
          job.status !== 'pending' ||
          job.arrival !== arrival ||
          (Date.parse(job.through) - Date.parse(job.from)) / 86400000 + 1 <=
            size
        )
          continue;
        const children = splitLargeJob(job, size);
        job.status = 'split';
        job.splitReason = 'pending_batch_size_updated';
        plan.jobs.splice(plan.jobs.indexOf(job) + 1, 0, ...children);
        changed++;
      }
      await save('progress.json', plan);
      console.log(JSON.stringify({ resizedPending: arrival, changed }));
    } else if (args.includes('--split-days')) {
      const job = plan.jobs.find((j) => j.id === option('--split-days'));
      const children = splitLargeJob(job, Number(option('--days')));
      job.status = 'split';
      job.splitReason = 'manual_small_batches_after_source_review';
      plan.jobs.splice(plan.jobs.indexOf(job) + 1, 0, ...children);
      await save('progress.json', plan);
      console.log(
        JSON.stringify({ split: job.id, children: children.map((j) => j.id) }),
      );
    } else if (args.includes('--split-window')) {
      const job = plan.jobs.find((j) => j.id === option('--split-window'));
      const dates = JSON.parse(
        await fs.readFile(option('--window-file'), 'utf8'),
      );
      const children = splitUncoveredWindow(job, dates);
      job.status = 'split';
      job.observedDates = dates;
      // Work on the intersecting dates first; retain uncovered boundary dates in the queue.
      plan.jobs.splice(plan.jobs.indexOf(job) + 1, 0, children[0]);
      plan.jobs.push(...children.slice(1));
      await save('progress.json', plan);
      console.log(
        JSON.stringify({
          split: job.id,
          children: children.map((j) => ({
            id: j.id,
            from: j.from,
            through: j.through,
          })),
        }),
      );
      process.exitCode = 0;
    } else if (args.includes('--replay-failed')) {
      const job = plan.jobs.find((j) => j.id === option('--replay-failed'));
      if (!job || job.status !== 'failed')
        throw new Error('Replay requires a failed job');
      const sampleDir = job.attempts.at(-1).sampleDir;
      execFileSync(
        process.execPath,
        [
          'node_modules/tsx/dist/cli.mjs',
          'scripts/crawler/validate-eva-http.ts',
          '--sample-dir',
          sampleDir,
          '--date',
          job.queryDate,
          '--arrival',
          job.arrival,
          '--from',
          job.from,
          '--through',
          job.through,
          '--mode',
          'validate',
          '--python',
          python,
        ],
        { encoding: 'utf8', timeout: 20000, maxBuffer: 4000000 },
      );
      const receipt = JSON.parse(
        await fs.readFile(path.join(sampleDir, 'receipt.json'), 'utf8'),
      );
      const analysis = JSON.parse(
        await fs.readFile(path.join(sampleDir, 'analysis.json'), 'utf8'),
      );
      Object.assign(
        job,
        ingestVerifiedJob(job, receipt, analysis, sampleDir, {
          offlineRecovery: true,
        }),
      );
      if (job.coverage.some((c) => c.evaOperatedRecords.length)) {
        const route = plan.catalog.find((r) => r.airport === job.arrival);
        route.directServiceProven = true;
        route.lastVerifiedAt = analysis.analyzedAt;
      }
      job.recoveredAt = new Date().toISOString();
      await save('progress.json', plan);
      await save('summary.json', summarize(plan));
      console.log(
        JSON.stringify({ offlineRecovered: job.id, ...summarize(plan) }),
      );
    } else {
      const maxJobs = Number(option('--max-jobs') ?? 1);
      if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 4)
        throw new Error('Use 1 to 4 jobs per invocation');
      if (plan.jobs.some((j) => j.status === 'running')) {
        // Prior process ended unexpectedly. Keep its evidence; a new attempt needs explicit retry.
        for (const j of plan.jobs.filter((j) => j.status === 'running')) {
          j.status = 'failed';
          j.error = 'Prior process interrupted; inspect evidence before retry';
        }
        await save('progress.json', plan);
        throw new Error(
          'Interrupted job recorded; inspect it and use --retry-failed',
        );
      }
      if (
        plan.jobs.some((j) => j.status === 'failed') &&
        !args.includes('--retry-failed')
      )
        throw new Error(
          'Failed jobs exist; inspect evidence before --retry-failed',
        );
      const selectedId = option('--only-job');
      if (selectedId && !plan.jobs.some((j) => j.id === selectedId))
        throw new Error('Unknown job id');
      const jobs = plan.jobs
        .filter(
          (j) =>
            (!selectedId || j.id === selectedId) &&
            (j.status === 'pending' ||
              (args.includes('--retry-failed') && j.status === 'failed')),
        )
        .slice(0, maxJobs);
      for (const job of jobs) {
        const sampleDir = path.join(
          directory,
          'attempts',
          `${job.id}-${job.attempts.length + 1}`,
        );
        job.status = 'running';
        job.attempts.push({ sampleDir, startedAt: new Date().toISOString() });
        await save('progress.json', plan);
        console.log(
          JSON.stringify({
            starting: job.id,
            from: job.from,
            through: job.through,
          }),
        );
        const result = spawnSync(
          process.execPath,
          [
            'scripts/crawler/fetch-eva-form-node.mjs',
            '--arrival',
            job.arrival,
            '--date',
            job.queryDate,
            '--collect-details',
            '--from',
            job.from,
            '--through',
            job.through,
            '--python',
            python,
            '--output-dir',
            sampleDir,
          ],
          {
            encoding: 'utf8',
            timeout: 180000,
            maxBuffer: 4000000,
            windowsHide: true,
          },
        );
        try {
          const receipt = JSON.parse(
            await fs.readFile(path.join(sampleDir, 'receipt.json'), 'utf8'),
          );
          job.attempts.at(-1).receiptStatus = receipt.status;
          if (
            result.status !== 0 ||
            receipt.status !== 'verified_requested_scope'
          )
            throw new Error(
              receipt.error ??
                result.error?.message ??
                'Collector did not verify scope',
            );
          const analysis = JSON.parse(
            await fs.readFile(path.join(sampleDir, 'analysis.json'), 'utf8'),
          );
          Object.assign(
            job,
            ingestVerifiedJob(job, receipt, analysis, sampleDir),
          );
          if (job.coverage.some((c) => c.evaOperatedRecords.length)) {
            const route = plan.catalog.find((r) => r.airport === job.arrival);
            route.directServiceProven = true;
            route.lastVerifiedAt = receipt.finishedAt;
          }
          delete job.error;
          console.log(
            JSON.stringify({
              finished: job.id,
              verifiedDates: job.coverage.length,
              records: analysis.records.length,
            }),
          );
        } catch (error) {
          job.status = 'failed';
          job.error = error.message.slice(0, 500);
          await save('progress.json', plan);
          console.log(JSON.stringify({ stopped: job.id, error: job.error }));
          process.exitCode = 1;
          break; // Stop the batch on any refusal, malformed result or incomplete receipt.
        }
        await save('progress.json', plan);
        await delay(1500);
      }
      await save('summary.json', summarize(plan));
      console.log(JSON.stringify(summarize(plan)));
    }
  }
} finally {
  await lock.close();
  await fs.unlink(path.join(directory, 'run.lock'));
}
