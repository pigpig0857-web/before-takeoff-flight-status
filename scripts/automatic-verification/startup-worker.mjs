// Detached local worker: page rendering never waits for source collection.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
const [python, token] = process.argv.slice(2);
if (!python || !token) throw new Error('Missing worker parameters');
const base = path.resolve('data/automatic-verification');
const stateFile = path.join(base, 'startup-attempt.json');
const logFile = path.join(base, `startup-${token}.log`);
let state = 'completed',
  reason = '';
try {
  // Start only after the server has durably handed off this exact token.
  for (let n = 0; n < 100; n++) {
    const owner = JSON.parse(
      await fs
        .readFile(path.join(base, 'startup.lock'), 'utf8')
        .catch(() => '{}'),
    );
    const attempt = JSON.parse(
      await fs.readFile(stateFile, 'utf8').catch(() => '{}'),
    );
    if (
      owner.token === token &&
      owner.pid === process.pid &&
      attempt.token === token
    )
      break;
    if (n === 99)
      throw new Error(
        'Startup ownership was not saved; no source requests issued',
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // At most four resumable 15-minute batches; known failures are not retried.
  for (let batch = 0; batch < 4; batch++) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--use-system-ca',
          '--import',
          'tsx',
          'scripts/automatic-verification/run.ts',
          '--python',
          python,
          '--max-groups',
          '1000',
          '--max-minutes',
          '15',
        ],
        {
          cwd: process.cwd(),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (data) => {
        stdout += data;
        if (stdout.length > 2_000_000) child.kill();
      });
      child.stderr.on('data', (data) => {
        stderr += data;
        if (stderr.length > 2_000_000) child.kill();
      });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
    await fs.appendFile(
      logFile,
      `${new Date().toISOString()} batch ${batch + 1}\n${result.stdout}\n${result.stderr}\n`,
    );
    if (result.code !== 0) {
      state = 'pending';
      reason = '核對程序未完成，已保存進度，保留原班表。';
      break;
    }
    const outcome = JSON.parse(result.stdout.trim());
    // Exit code zero means the batch was saved, not that every flight passed.
    // Keep the actual outcome so pending sources never become "completed".
    if (
      ![
        'batch_saved',
        'verified',
        'completed_with_pending',
        'scope_expired',
      ].includes(outcome.state)
    )
      throw new Error('Unknown verification outcome; inspect saved batch');
    state = outcome.state;
    if (state === 'completed_with_pending')
      reason = '本輪已保存，仍有來源或班次待確認；保留原班表，不重送失敗來源。';
    if (outcome.state !== 'batch_saved') break;
  }
} catch (e) {
  state = 'pending';
  reason = String(e.message).slice(0, 800);
  await fs.appendFile(logFile, reason + '\n').catch(() => {});
} finally {
  const current = JSON.parse(
    await fs.readFile(stateFile, 'utf8').catch(() => '{}'),
  );
  if (current.token === token)
    await fs.writeFile(
      stateFile,
      JSON.stringify(
        { ...current, state, reason, finishedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
  const lock = path.join(base, 'startup.lock');
  const owner = JSON.parse(await fs.readFile(lock, 'utf8').catch(() => '{}'));
  if (owner.token === token) await fs.unlink(lock);
}
