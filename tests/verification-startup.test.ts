import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  startupVerificationDue,
  maybeStartTimetableVerification,
} from '../src/server/services/verification-startup';
import { taipeiDate } from '../src/lib/time';
const now = Date.parse('2026-10-14T07:00:00Z');
async function fixture() {
  const parent = path.resolve('data/cache/startup-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'case-'));
  await fs.mkdir(path.join(root, 'data/automatic-verification'), {
    recursive: true,
  });
  return root;
}
test('Opening with current data does not start collection; the boundary is 24h and incomplete batches have backoff', () => {
  assert.equal(startupVerificationDue(undefined, now), true);
  assert.equal(
    startupVerificationDue(new Date(now - 23 * 3600_000).toISOString(), now),
    false,
  );
  assert.equal(
    startupVerificationDue(new Date(now - 24 * 3600_000).toISOString(), now),
    true,
  );
  assert.equal(
    startupVerificationDue(new Date(now - 60_000).toISOString(), now, true),
    false,
  );
  assert.equal(
    startupVerificationDue(new Date(now - 120_000).toISOString(), now, true),
    true,
  );
});
test('Completed daily work with denied sources is not retried just because the website reopens', async () => {
  const root = await fixture(),
    base = path.join(root, 'data/automatic-verification');
  await fs.mkdir(path.join(base, 'runs', taipeiDate(new Date(now))), {
    recursive: true,
  });
  const file = path.join(
    base,
    'runs',
    taipeiDate(new Date(now)),
    'progress.json',
  );
  const content = JSON.stringify({ state: 'completed_with_pending' });
  await fs.writeFile(file, content);
  assert.equal(
    await maybeStartTimetableVerification(root, now),
    'already_checked_today',
  );
  assert.equal(await fs.readFile(file, 'utf8'), content);
  await assert.rejects(fs.access(path.join(base, 'startup-attempt.json')));
});
test('An existing collector is respected and recent attempts prevent repeated launches', async () => {
  const root = await fixture(),
    base = path.join(root, 'data/automatic-verification');
  const lock = path.join(base, 'run.lock');
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid }));
  assert.equal(await maybeStartTimetableVerification(root, now), 'running');
  await fs.unlink(lock);
  await fs.writeFile(
    path.join(base, 'startup-attempt.json'),
    JSON.stringify({ startedAt: new Date(now - 1000).toISOString() }),
  );
  assert.equal(await maybeStartTimetableVerification(root, now), 'recent');
});
test('Concurrent page opens start one hidden background process, without waiting for it to finish', async () => {
  const root = await fixture(),
    base = path.join(root, 'data/automatic-verification');
  await fs.mkdir(path.join(root, 'scripts/automatic-verification'), {
    recursive: true,
  });
  await fs.mkdir(path.join(root, 'node_modules/tsx/dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules/tsx/dist/loader.mjs'), '');
  // A recent focused result is not a completed daily check of all airlines.
  await fs.writeFile(
    path.join(base, 'latest.json'),
    JSON.stringify({
      entries: { focused: { attemptedAt: new Date(now).toISOString() } },
    }),
  );
  // Local probe only: never requests airline data.
  await fs.writeFile(
    path.join(root, 'scripts/automatic-verification/startup-worker.mjs'),
    "import fs from 'node:fs/promises'; await fs.writeFile('probe-started.txt',process.argv[3]); await new Promise(r=>setTimeout(r,1500));",
  );
  const start = Date.now();
  const results = await Promise.all([
    maybeStartTimetableVerification(root, now),
    maybeStartTimetableVerification(root, now),
  ]);
  assert.equal(results.filter((r) => r === 'started').length, 1);
  assert.equal(results.filter((r) => r === 'running').length, 1);
  assert.ok(Date.now() - start < 1500, 'Parent waited for collection');
  const status = JSON.parse(
    await fs.readFile(path.join(base, 'startup-attempt.json'), 'utf8'),
  );
  assert.equal(status.state, 'running');
  assert.ok(status.pid > 0);
});
test('Interrupted daily batches resume after two minutes even if the worker did not return batch_saved', async () => {
  const root = await fixture(),
    base = path.join(root, 'data/automatic-verification');
  const dir = path.join(base, 'runs', taipeiDate(new Date(now)));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'progress.json'),
    JSON.stringify({ state: 'running' }),
  );
  await fs.writeFile(
    path.join(base, 'startup-attempt.json'),
    JSON.stringify({ startedAt: new Date(now - 121_000).toISOString() }),
  );
  // Reaching the runtime check proves it did not skip as "recent". No worker
  // exists in this fixture, so this cannot issue any source requests.
  await assert.rejects(maybeStartTimetableVerification(root, now), {
    code: 'ENOENT',
  });
});
test('Expired date scope does not create files or start collection', async () => {
  const root = await fixture();
  assert.equal(
    await maybeStartTimetableVerification(
      root,
      Date.parse('2027-01-01T00:00:00+08:00'),
    ),
    'disabled',
  );
  await assert.rejects(
    fs.access(
      path.join(root, 'data/automatic-verification/startup-attempt.json'),
    ),
  );
});

test('A new eligible day starts in isolation while preserving the previous day stops and completed batch', async () => {
  const root = await fixture(),
    base = path.join(root, 'data/automatic-verification');
  const previousDay = '2026-10-13';
  await fs.mkdir(path.join(base, 'runs', previousDay), { recursive: true });
  await fs.mkdir(path.join(base, 'source-stops'), { recursive: true });
  const oldProgress = path.join(base, 'runs', previousDay, 'progress.json');
  const oldStops = path.join(base, 'source-stops', previousDay + '.json');
  const progress = JSON.stringify({ state: 'completed_with_pending' });
  const stops = JSON.stringify({
    'official.example': { reason: 'previous refusal' },
  });
  await fs.writeFile(oldProgress, progress);
  await fs.writeFile(oldStops, stops);
  await fs.writeFile(
    path.join(base, 'startup-attempt.json'),
    JSON.stringify({
      state: 'completed_with_pending',
      startedAt: new Date(now - 25 * 3600_000).toISOString(),
    }),
  );
  await fs.mkdir(path.join(root, 'scripts/automatic-verification'), {
    recursive: true,
  });
  await fs.mkdir(path.join(root, 'node_modules/tsx/dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules/tsx/dist/loader.mjs'), '');
  // A local launch probe, deliberately incapable of querying any source.
  await fs.writeFile(
    path.join(root, 'scripts/automatic-verification/startup-worker.mjs'),
    "import fs from 'node:fs/promises'; await fs.writeFile('probe-started.txt', process.argv[3]);",
  );
  assert.equal(await maybeStartTimetableVerification(root, now), 'started');
  let probe = '';
  for (let attempt = 0; attempt < 50; attempt++) {
    probe = await fs
      .readFile(path.join(root, 'probe-started.txt'), 'utf8')
      .catch(() => '');
    if (probe) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const status = JSON.parse(
    await fs.readFile(path.join(base, 'startup-attempt.json'), 'utf8'),
  );
  assert.equal(probe, status.token);
  assert.equal(await fs.readFile(oldProgress, 'utf8'), progress);
  assert.equal(await fs.readFile(oldStops, 'utf8'), stops);
  await assert.rejects(
    fs.access(
      path.join(base, 'runs', taipeiDate(new Date(now)), 'progress.json'),
    ),
  );
});

test('A proven dead process lock is preserved after interruption without reissuing completed daily work', async () => {
  const root = await fixture(),
    base = path.join(root, 'data/automatic-verification');
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
    windowsHide: true,
  });
  assert.equal(exited.status, 0);
  assert.ok(exited.pid > 0);
  const lock = JSON.stringify({
    pid: exited.pid,
    token: 'interrupted-test-only',
  });
  await fs.writeFile(path.join(base, 'run.lock'), lock);
  await fs.mkdir(path.join(base, 'runs', taipeiDate(new Date(now))), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(base, 'runs', taipeiDate(new Date(now)), 'progress.json'),
    JSON.stringify({ state: 'completed_with_pending' }),
  );
  assert.equal(
    await maybeStartTimetableVerification(root, now),
    'already_checked_today',
  );
  await assert.rejects(fs.access(path.join(base, 'run.lock')));
  const saved = (await fs.readdir(base)).filter((file) =>
    file.startsWith('run.lock.interrupted-'),
  );
  assert.equal(saved.length, 1);
  assert.equal(await fs.readFile(path.join(base, saved[0]), 'utf8'), lock);
  await assert.rejects(fs.access(path.join(base, 'startup-attempt.json')));
});
