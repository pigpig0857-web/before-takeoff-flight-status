import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { inspectRuntimeTrust } from '../scripts/automatic-verification/runtime-trust';

test('Missing Windows system trust or disabled TLS verification stops before any request', () => {
  const certificates = (type?: string) =>
    type === 'system' ? ['system'] : ['bundled'];
  assert.equal(inspectRuntimeTrust(certificates, {}, 'win32').ready, false);
  const loaded = (type?: string) =>
    type === 'system' ? ['system'] : ['system', 'bundled'];
  assert.equal(inspectRuntimeTrust(loaded, {}, 'win32').ready, true);
  assert.equal(
    inspectRuntimeTrust(loaded, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, 'win32')
      .ready,
    false,
  );
  assert.equal(inspectRuntimeTrust(() => [], {}, 'win32').ready, false);
});

async function runWorker(outcome: string) {
  const parent = path.resolve('data/cache/worker-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'case-'));
  const base = path.join(root, 'data/automatic-verification');
  await fs.mkdir(base, { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules/tsx'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'node_modules/tsx/package.json'),
    JSON.stringify({ type: 'module', exports: './index.mjs' }),
  );
  await fs.writeFile(path.join(root, 'node_modules/tsx/index.mjs'), '');
  await fs.mkdir(path.join(root, 'scripts/automatic-verification'), {
    recursive: true,
  });
  // Real worker/real child process, entirely local fixture: no airline requests.
  await fs.writeFile(
    path.join(root, 'scripts/automatic-verification/run.ts'),
    `
    import fs from 'node:fs';
    if (!process.execArgv.includes('--use-system-ca')) throw Error('System CA flag lost');
    fs.appendFileSync('batches.txt', 'batch\\n');
    console.log(JSON.stringify({ state: ${JSON.stringify(outcome)} }));
  `,
  );
  const token = randomUUID();
  await fs.writeFile(
    path.join(base, 'startup-attempt.json'),
    JSON.stringify({ token, state: 'running' }),
  );
  const child = spawn(
    process.execPath,
    [
      path.resolve('scripts/automatic-verification/startup-worker.mjs'),
      process.execPath,
      token,
    ],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const finished = new Promise<void>((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.stdout.resume();
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(Error(stderr)),
    );
  });
  await fs.writeFile(
    path.join(base, 'startup.lock'),
    JSON.stringify({ token, pid: child.pid }),
  );
  await finished;
  await assert.rejects(fs.access(path.join(base, 'startup.lock')), {
    code: 'ENOENT',
  });
  const result = JSON.parse(
    await fs.readFile(path.join(base, 'startup-attempt.json'), 'utf8'),
  );
  const batches = (await fs.readFile(path.join(root, 'batches.txt'), 'utf8'))
    .trim()
    .split('\n').length;
  return { result, batches };
}

test('Background worker retains pending outcome instead of reporting completed, with no repeated batch', async () => {
  const { result, batches } = await runWorker('completed_with_pending');
  assert.equal(result.state, 'completed_with_pending');
  assert.match(result.reason, /待確認/);
  assert.equal(batches, 1);
});
test('Background worker reports verified only when the collector verifies the batch', async () => {
  const { result, batches } = await runWorker('verified');
  assert.equal(result.state, 'verified');
  assert.equal(batches, 1);
});
test('Background worker saves continuation after its four-batch limit', async () => {
  const { result, batches } = await runWorker('batch_saved');
  assert.equal(result.state, 'batch_saved');
  assert.equal(batches, 4);
});
test('Unknown collector outcome cannot be mislabeled as a completed verification', async () => {
  const { result, batches } = await runWorker('unexpected');
  assert.equal(result.state, 'pending');
  assert.equal(batches, 1);
});
