import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pilotConfig, verifyPilotResult } from './pilot-config.mjs';
import { Storage } from './storage.mjs';

const execute = (command, args, timeout = 600000) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', timeout });
    child.on('error', reject);
    child.on('exit', (code, signal) =>
      code === 0
        ? resolve()
        : reject(Error(`Collector stopped (${signal || code}).`)),
    );
  });
async function main() {
  const config = pilotConfig();
  const storage = new Storage(config.bucket);
  const report = {
    id: config.id,
    startedAt: new Date().toISOString(),
    departure: 'TPE',
    date: config.date,
    airports: config.airports,
    status: 'running',
    results: [],
    integratedIntoWebsite: false,
    allPublishedFlightsGuaranteed: false,
  };
  const lockName = 'eva-pilot/control/run.lock';
  // Conditional creation prevents overlapping runs. A timed-out job leaves a visible lock for review.
  const lock = await storage.put(
    lockName,
    JSON.stringify({ id: config.id, startedAt: report.startedAt }),
  );
  await fs.mkdir(config.directory, { recursive: true });
  const reportFile = path.join(config.directory, 'report.json');
  let failure;
  try {
    for (const airport of config.airports) {
      const directory = path.join(config.directory, airport);
      await execute(process.execPath, [
        'scripts/crawler/fetch-eva-form-node.mjs',
        '--date',
        config.date,
        '--arrival',
        airport,
        '--python',
        process.env.PYTHON || 'python3',
        '--output-dir',
        directory,
        '--collect-details',
      ]);
      const receipt = JSON.parse(
        await fs.readFile(path.join(directory, 'receipt.json'), 'utf8'),
      );
      const analysis = JSON.parse(
        await fs.readFile(path.join(directory, 'analysis.json'), 'utf8'),
      );
      const count = verifyPilotResult(receipt, analysis, airport, config.date);
      report.results.push({
        airport,
        verifiedRecords: count,
        requests: receipt.requests.length,
      });
      await storage.put(
        `${config.prefix}/${airport}/analysis.json`,
        JSON.stringify(analysis),
      );
      await storage.put(
        `${config.prefix}/${airport}/receipt.json`,
        JSON.stringify(receipt),
      );
    }
    report.status = 'verified_requested_scope';
  } catch (error) {
    failure = error;
    report.status = 'failed';
    report.error = error.message;
  }
  try {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
    const archivePath = `${config.directory}.tar.gz`;
    await execute(
      'tar',
      ['-czf', archivePath, '-C', config.directory, '.'],
      60000,
    );
    const archive = await fs.readFile(archivePath);
    const artifact = await storage.put(
      `${config.prefix}/evidence.tar.gz`,
      archive,
      'application/gzip',
    );
    report.evidence = {
      object: `${config.prefix}/evidence.tar.gz`,
      generation: artifact.generation,
      sha256: createHash('sha256').update(archive).digest('hex'),
    };
    await storage.put(
      `${config.prefix}/report.json`,
      JSON.stringify(report, null, 2),
    );
    // This is a per-run completion marker, never a website "latest" pointer.
    if (!failure)
      await storage.put(
        `${config.prefix}/complete.json`,
        JSON.stringify({
          date: config.date,
          airports: config.airports,
          verifiedRecords: report.results.reduce(
            (n, r) => n + r.verifiedRecords,
            0,
          ),
          reportObject: `${config.prefix}/report.json`,
        }),
      );
  } finally {
    await storage.release(lockName, lock.generation);
  }
  console.log(
    JSON.stringify({
      ...report,
      location: `gs://${config.bucket}/${config.prefix}/`,
    }),
  );
  if (failure) throw failure;
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
