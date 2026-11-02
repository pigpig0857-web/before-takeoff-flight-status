import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { taipeiDate } from '@/lib/time';

const DAY = 24 * 3600_000;
export function startupVerificationDue(
  lastAttempt: string | undefined,
  now: number,
  unfinished = false,
) {
  const at = Date.parse(lastAttempt || '');
  return (
    !Number.isFinite(at) || (unfinished ? now - at >= 120_000 : now - at >= DAY)
  );
}
const read = async (file: string) => {
  try {
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
};
function alive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return true; // Unknown owner is not safe to replace.
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
/** Preserve an interrupted lock as evidence; never take over a live process. */
async function recoverDeadLock(file: string) {
  const old = await read(file);
  if (!old) return false;
  if (alive(old.pid)) return true;
  await fs.rename(file, `${file}.interrupted-${randomUUID()}.json`);
  return false;
}
export async function maybeStartTimetableVerification(
  workspace = process.cwd(),
  now = Date.now(),
) {
  if (
    process.env.K_SERVICE ||
    process.env.FLIGHT_DATA_MODE === 'demo' ||
    taipeiDate(new Date(now)) > '2026-12-31'
  )
    return 'disabled';
  const base = path.join(workspace, 'data/automatic-verification');
  await fs.mkdir(base, { recursive: true });
  if (
    (await recoverDeadLock(path.join(base, 'startup.lock'))) ||
    (await recoverDeadLock(path.join(base, 'run.lock')))
  )
    return 'running';
  const prior = await read(path.join(base, 'startup-attempt.json'));
  const date = taipeiDate(new Date(now));
  const today = await read(path.join(base, 'runs', date, 'progress.json'));
  // Completed daily work (including source denials) is never reissued on refresh.
  if (
    today &&
    ['verified', 'completed_with_pending', 'completed'].includes(today.state)
  )
    return 'already_checked_today';
  // A focused check of one airline must not postpone the other airlines.
  // Only a background launch controls the cooldown; the daily progress above
  // remains authoritative for completed (including denied) source groups.
  if (
    !startupVerificationDue(
      prior?.startedAt,
      now,
      !!today || prior?.state === 'pending',
    )
  )
    return 'recent';
  const worker = path.join(
    workspace,
    'scripts/automatic-verification/startup-worker.mjs',
  );
  const loader = path.join(workspace, 'node_modules/tsx/dist/loader.mjs');
  const python =
    process.env.FLIGHT_VERIFICATION_PYTHON ||
    path.join(
      os.homedir(),
      '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',
    );
  await Promise.all([fs.access(worker), fs.access(loader), fs.access(python)]);
  let lock;
  try {
    lock = await fs.open(path.join(base, 'startup.lock'), 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'running';
    throw e;
  }
  const token = randomUUID();
  try {
    await lock.writeFile(
      JSON.stringify({
        pid: process.pid,
        token,
        startedAt: new Date(now).toISOString(),
      }),
    );
    const child = spawn(process.execPath, [worker, python, token], {
      cwd: workspace,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const status = {
      pid: child.pid,
      token,
      startedAt: new Date(now).toISOString(),
      state: 'running',
    };
    await fs.writeFile(
      path.join(base, 'startup-attempt.json'),
      JSON.stringify(status, null, 2),
    );
    await lock.truncate(0);
    await lock.write(JSON.stringify(status), 0, 'utf8');
    child.unref();
    return 'started';
  } catch (e) {
    await fs.unlink(path.join(base, 'startup.lock')).catch(() => {});
    throw e;
  } finally {
    await lock.close();
  }
}
