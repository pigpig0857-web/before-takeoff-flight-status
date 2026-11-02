/** Bounded live checks with durable receipts. No scheduler or website mutation. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { taipeiDate } from '../../src/lib/time';

const execute = promisify(execFile);
const root = process.cwd();
const output = path.resolve('data/cache/ci-network');
const evidence = path.resolve('data/source-samples/crawler/ci-stability');
const files = [
  'data/source-samples/crawler/ci-network-latest.pdf',
  'data/source-samples/crawler/ci-network-extraction.json',
  ...[
    'coverage.json',
    'rules.json',
    'flights.json',
    'flights.csv',
    'overview.md',
  ].map((file) => `data/cache/ci-network/${file}`),
];
const digest = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex');
async function hashes() {
  const entries = await Promise.all(
    files.map(async (file) => {
      try {
        return [file, digest(await fs.readFile(path.resolve(file)))];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return [file, null];
      }
    }),
  );
  return Object.fromEntries(entries);
}
async function receipt() {
  try {
    const coverage = JSON.parse(
      await fs.readFile(path.join(output, 'coverage.json'), 'utf8'),
    );
    const { records } = JSON.parse(
      await fs.readFile(path.join(output, 'flights.json'), 'utf8'),
    );
    // Exclude observation timestamps; include schedule, airports, duration and source hash.
    const identity = (r: Record<string, unknown>) => {
      const { sourceRetrievedAt, parsedAt, ...schedule } = r;
      return JSON.stringify(schedule);
    };
    return {
      coverage,
      scheduleHash: digest(records.map(identity).sort().join('\n')),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const i = args.indexOf(name);
    if (i >= 0 && !args[i + 1]) throw new Error(`Missing ${name}`);
    return i < 0 ? undefined : args[i + 1];
  };
  const runs = Number(option('--runs') ?? 1);
  if (!Number.isInteger(runs) || runs < 1 || runs > 3)
    throw new Error(
      'Use --runs 1..3; live requests are sequential and bounded',
    );
  const python = option('--python') || process.env.PYTHON_BINARY || 'python';
  const date = taipeiDate();
  await fs.mkdir(evidence, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = path.join(evidence, runId);
  await fs.mkdir(directory);
  const before = await receipt();
  const report: {
    startedAt: string;
    date: string;
    baseline: unknown;
    runs: unknown[];
    failureProbe?: unknown;
    finishedAt?: string;
  } = {
    startedAt: new Date().toISOString(),
    date,
    baseline: before,
    runs: [],
  };
  const save = async () => {
    await fs.writeFile(
      path.join(directory, 'report.json'),
      JSON.stringify(report, null, 2),
    );
    await fs.writeFile(
      path.join(evidence, 'latest.json'),
      JSON.stringify(report, null, 2),
    );
  };
  await save();
  let previous = before;
  for (let index = 0; index < runs; index++) {
    const startedAt = new Date().toISOString(),
      started = performance.now();
    const preserved = await hashes();
    try {
      await execute(
        process.execPath,
        [
          path.resolve('node_modules/tsx/dist/cli.mjs'),
          path.resolve('scripts/crawler/trial-ci-network.ts'),
          '--from',
          date,
          '--python',
          python,
        ],
        { cwd: root, timeout: 70_000, maxBuffer: 100_000, windowsHide: true },
      );
      const current = await receipt();
      if (
        !current ||
        current.coverage.mode !== 'live_pdf_download' ||
        current.coverage.sourceRetrievedAt < startedAt ||
        !current.coverage.allPublishedDatesValidated ||
        current.coverage.validationFailures.length
      )
        throw new Error(
          'Collector did not produce a fresh validated live receipt',
        );
      const sameWindow =
        previous?.coverage.actualFrom === current.coverage.actualFrom;
      report.runs.push({
        index: index + 1,
        startedAt,
        finishedAt: new Date().toISOString(),
        collectorElapsedMs: Math.round(performance.now() - started),
        status: 'success',
        sourceHashMatchesPrevious: previous
          ? previous.coverage.sha256 === current.coverage.sha256
          : null,
        scheduleMatchesPrevious: sameWindow
          ? previous?.scheduleHash === current.scheduleHash
          : null,
        ...current,
      });
      previous = current;
    } catch (error) {
      const after = await hashes();
      report.runs.push({
        index: index + 1,
        startedAt,
        finishedAt: new Date().toISOString(),
        collectorElapsedMs: Math.round(performance.now() - started),
        status: 'failed',
        previousFilesUnchanged:
          JSON.stringify(preserved) === JSON.stringify(after),
        error: (error instanceof Error ? error.message : String(error)).slice(
          0,
          1200,
        ),
      });
      await save();
      throw error;
    }
    await save();
  }
  if (args.includes('--check-failure')) {
    // Offline only: deliberately unavailable extractor; never corrupt a real source.
    const preserved = await hashes();
    let refused = false;
    try {
      await execute(
        process.execPath,
        [
          path.resolve('node_modules/tsx/dist/cli.mjs'),
          path.resolve('scripts/crawler/trial-ci-network.ts'),
          '--offline',
          '--from',
          date,
          '--python',
          path.join(directory, 'intentionally-unavailable-python.exe'),
        ],
        { cwd: root, timeout: 15_000, maxBuffer: 10_000, windowsHide: true },
      );
    } catch {
      refused = true;
    }
    const unchanged =
      JSON.stringify(preserved) === JSON.stringify(await hashes());
    report.failureProbe = {
      mode: 'offline_missing_extractor',
      refused,
      previousFilesUnchanged: unchanged,
      networkRequests: 0,
    };
    await save();
    if (!refused || !unchanged)
      throw new Error('Failure must preserve previous successful files');
  }
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify(
      {
        report: path.join(directory, 'report.json'),
        liveChecks: report.runs.length,
        failureProbe: report.failureProbe,
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
