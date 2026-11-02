// Double-click entry: reuse a healthy local site, otherwise start it hidden.
import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const args = process.argv.slice(2);
const port = Number(
  args.includes('--port') ? args[args.indexOf('--port') + 1] : 3000,
);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('無效的網站連接埠。');
const url = `http://127.0.0.1:${port}/`;
const folder = path.join(workspace, 'data/cache/site-launcher');
const next = path.join(workspace, 'node_modules/next/dist/bin/next');
const lockFile = path.join(folder, `launch-${port}.lock`);
const serverFile = path.join(folder, `server-${port}.json`);

async function health() {
  try {
    const response = await fetch(url + 'api/health', {
      signal: AbortSignal.timeout(1500),
      redirect: 'manual',
    });
    const body = await response.json().catch(() => null);
    if (
      response.ok &&
      body?.service === 'flight-status' &&
      body?.status === 'ok'
    )
      return true;
    throw new Error(
      '這個網址目前被其他服務使用，請勿關閉不明程式；請將此訊息提供給協助維護的人。',
    );
  } catch (e) {
    if (e.cause?.code === 'ECONNREFUSED' || e.name === 'TimeoutError')
      return false;
    throw e;
  }
}
async function waitForSite(milliseconds) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (await health()) return;
    await delay(350);
  }
  throw new Error(`網站未能正常啟動，請保留 ${folder} 中的紀錄以便檢查。`);
}
async function openBrowser() {
  if (args.includes('--no-open')) return;
  const browser = spawn('explorer.exe', [url], {
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  await new Promise((resolve, reject) => {
    browser.once('spawn', resolve);
    browser.once('error', reject);
  });
  browser.unref();
}
async function runNext(arguments_, logName, detached = false) {
  const log = openSync(path.join(folder, logName), 'a');
  let child;
  try {
    child = spawn(process.execPath, ['--use-system-ca', next, ...arguments_], {
      cwd: workspace,
      windowsHide: true,
      detached,
      stdio: ['ignore', log, log],
    });
    if (detached) {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      return child.pid;
    }
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0
          ? resolve()
          : reject(new Error('網站準備未完成，請查看啟動紀錄。')),
      );
    });
  } finally {
    closeSync(log);
  }
}
async function main() {
  if (await health()) {
    console.log(`網站已在運作：${url}`);
    await openBrowser();
    return;
  }
  await fs.access(next).catch(() => {
    throw new Error('專案的網站套件不完整，請先完成專案安裝。');
  });
  await fs.mkdir(folder, { recursive: true });
  let lock;
  try {
    lock = await fs.open(lockFile, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const owner = JSON.parse(await fs.readFile(lockFile, 'utf8'));
    if (!Number.isInteger(owner.pid) || owner.pid <= 0)
      throw new Error('啟動紀錄需要檢查，請保留原檔。');
    let alive = true;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') alive = false;
      else throw error;
    }
    if (alive) {
      await waitForSite(60000);
      await openBrowser();
      return;
    }
    await fs.rename(lockFile, `${lockFile}.interrupted-${Date.now()}.json`);
    lock = await fs.open(lockFile, 'wx');
  }
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    );
    if (!(await health())) {
      try {
        await fs.access(path.join(workspace, '.next/BUILD_ID'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        console.log('正在準備網站，第一次啟動可能需要約一分鐘。');
        await runNext(['build'], 'build.log');
      }
      console.log('正在啟動航班網站…');
      const pid = await runNext(
        ['start', '--hostname', '127.0.0.1', '--port', String(port)],
        `server-${port}.log`,
        true,
      );
      await fs.writeFile(
        serverFile,
        JSON.stringify(
          { pid, url, workspace, startedAt: new Date().toISOString() },
          null,
          2,
        ) + '\n',
      );
      await waitForSite(30000);
    }
    console.log(`航班網站已開啟：${url}`);
    await openBrowser();
  } finally {
    await lock.close();
    await fs.unlink(lockFile);
  }
}
main().catch((error) => {
  console.error(`無法開啟航班網站：${error.message}`);
  process.exitCode = 1;
});
