import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  compareSchedules,
  validateSnapshot,
  type Airline,
  type ObservationScope,
} from './compare';
import type { CollectedSnapshot } from '../../src/server/providers/collected';

const hash = (data: string | Buffer) =>
  createHash('sha256').update(data).digest('hex');
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
const cell = (value: unknown) =>
  String(value ?? '')
    .replaceAll('|', '\\|')
    .replace(/[\r\n]/g, ' ');
const csvCell = (value: unknown) => {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
async function atomic(file: string, value: unknown) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(tmp, json(value), { flag: 'wx' });
  await fs.rename(tmp, file);
}
function inside(root: string, file: string) {
  const rel = path.relative(root, file);
  assert.ok(
    rel && !rel.startsWith('..') && !path.isAbsolute(rel),
    'Path outside update workspace',
  );
}
function paths(workspace: string, airline: Airline) {
  assert.ok(['eva', 'peach'].includes(airline));
  return {
    target: path.join(workspace, 'src/server/data', airline + '-flights.json'),
    runs: path.join(workspace, 'data/flight-updates'),
    lock: path.join(workspace, 'data/flight-updates', airline + '.lock'),
  };
}
async function protectedHashes(workspace: string) {
  return Object.fromEntries(
    await Promise.all(
      ['peach-booking-checks.json', 'peach-verification-progress.json'].map(
        async (name) => [
          name,
          hash(
            await fs.readFile(path.join(workspace, 'src/server/data', name)),
          ),
        ],
      ),
    ),
  );
}
async function verifySource(
  workspace: string,
  file: string,
  candidateSha256: string,
  scope: ObservationScope,
  airline: Airline,
) {
  file = await fs.realpath(path.resolve(workspace, file));
  inside(workspace, file);
  const body = await fs.readFile(file),
    proof = JSON.parse(body.toString());
  assert.equal(proof.status, 'verified');
  assert.equal(proof.airline, airline);
  assert.equal(
    proof.candidateSha256,
    candidateSha256,
    'Source audit belongs to another candidate',
  );
  assert.deepEqual(proof.scope, scope, 'Source audit scope mismatch');
  assert.ok(
    Object.keys(proof.fileSha256).length,
    'Missing source evidence hashes',
  );
  for (const [relative, digest] of Object.entries(
    proof.fileSha256 as Record<string, string>,
  )) {
    const rawFile = await fs.realpath(path.resolve(workspace, relative));
    inside(workspace, rawFile);
    assert.equal(
      hash(await fs.readFile(rawFile)),
      digest,
      'Source evidence changed',
    );
  }
  return { file: path.relative(workspace, file), sha256: hash(body) };
}
async function locked<T>(
  workspace: string,
  airline: Airline,
  work: () => Promise<T>,
) {
  const p = paths(workspace, airline);
  await fs.mkdir(p.runs, { recursive: true });
  const lock = await fs.open(p.lock, 'wx');
  try {
    await lock.writeFile(
      json({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    return await work();
  } finally {
    await lock.close();
    await fs.unlink(p.lock);
  }
}

export async function prepareUpdate(
  workspace: string,
  airline: Airline,
  candidateFile: string,
  from: string,
  source?: { scope: ObservationScope; evidenceFile: string },
) {
  workspace = path.resolve(workspace);
  candidateFile = await fs.realpath(path.resolve(candidateFile));
  inside(workspace, candidateFile);
  return locked(workspace, airline, async () => {
    const p = paths(workspace, airline),
      raw = await fs.readFile(p.target),
      candidate = await fs.readFile(candidateFile);
    const before = JSON.parse(raw.toString()) as CollectedSnapshot,
      incoming = JSON.parse(candidate.toString()) as CollectedSnapshot;
    let sourceEvidence: { file: string; sha256: string } | undefined;
    if (source) {
      sourceEvidence = await verifySource(
        workspace,
        source.evidenceFile,
        hash(candidate),
        source.scope,
        airline,
      );
    }
    const prepared = compareSchedules(
      before,
      incoming,
      airline,
      from,
      undefined,
      source?.scope,
    );
    const run = path.join(
      p.runs,
      new Date().toISOString().replaceAll(':', '-') +
        '-' +
        airline +
        '-' +
        randomUUID().slice(0, 8),
    );
    await fs.mkdir(run);
    await fs.writeFile(path.join(run, 'before.json'), raw, { flag: 'wx' });
    await fs.writeFile(path.join(run, 'incoming.json'), candidate, {
      flag: 'wx',
    });
    const stage = json(prepared.staged),
      changes = json(prepared.changes);
    await fs.writeFile(path.join(run, 'candidate.json'), stage, { flag: 'wx' });
    await fs.writeFile(path.join(run, 'changes.json'), changes, { flag: 'wx' });
    const state = {
      version: 1,
      state: 'prepared',
      airline,
      from,
      through: '2026-12-31',
      preparedAt: new Date().toISOString(),
      originalSha256: hash(raw),
      incomingSha256: hash(candidate),
      candidateSha256: hash(stage),
      changesSha256: hash(changes),
      protectedHashes: await protectedHashes(workspace),
      summary: prepared.summary,
      websiteDataChanged: false,
      sourceEvidenceReviewRequired: true,
      ...(source ? { observationScope: source.scope, sourceEvidence } : {}),
    };
    const rows = [
      ...prepared.changes.added.map((r) => [
        '新增',
        r.date,
        r.number,
        r.airport,
        '',
        '',
        r.departure,
        '',
        r.arrival,
      ]),
      ...prepared.changes.changed.map((c) => [
        '變更',
        c.after.date,
        c.after.number,
        c.after.airport,
        c.fields.join('、'),
        c.before.departure,
        c.after.departure,
        c.before.arrival,
        c.after.arrival,
      ]),
      ...prepared.changes.pending.map((c) => [
        '保留待確認',
        c.record.date,
        c.record.number,
        c.record.airport,
        '來源未列出，不代表取消',
        c.record.departure,
        c.record.departure,
        c.record.arrival,
        c.record.arrival,
      ]),
    ];
    const header = [
      '分類',
      '出發日期',
      '航班',
      '機場',
      '變更欄位／原因',
      '原起飛（台灣時間）',
      '更新後起飛（台灣時間）',
      '原抵達（當地時間）',
      '更新後抵達（當地時間）',
    ];
    await fs.writeFile(
      path.join(run, 'changes.csv'),
      '\uFEFF' +
        [header, ...rows]
          .map((row) => row.map(csvCell).join(','))
          .join('\r\n') +
        '\r\n',
      { flag: 'wx' },
    );
    const table = rows.length
      ? '\n\n| ' +
        header.map(cell).join(' | ') +
        ' |\n| ' +
        header.map(() => '---').join(' | ') +
        ' |\n' +
        rows
          .slice(0, 200)
          .map((row) => '| ' + row.map(cell).join(' | ') + ' |')
          .join('\n') +
        (rows.length > 200
          ? '\n\n此處顯示前 200 筆，完整清單請查看 changes.csv。'
          : '')
      : '\n\n本批沒有基本航班資料差異。';
    await fs.writeFile(
      path.join(run, 'review.md'),
      `# 班表更新待檢查\n\n航空公司：${airline === 'eva' ? '長榮' : '樂桃'}；出發日期：${from}～2026/12/31（含）。\n\n新增 ${state.summary.added} 筆、基本資料變更 ${state.summary.changed} 筆、保留待確認 ${state.summary.retainedPending} 筆、刪除 0 筆。${source ? `\n\n本次核對 ${source.scope.cells.length} 個日期／機場組合；${state.summary.notRechecked} 筆尚未重新核對，保留原資料。來源驗證紀錄：${sourceEvidence!.file}。` : ''}\n\n原資料已備份；網站尚未更新。請檢查差異清單與對應官方原始證據，再決定是否套用。來源未列出不等於取消。${table}\n\n此工具驗證格式、日期、時區及官方來源網址，不取代官方證據內容核對。套用確認碼：${state.candidateSha256}\n`,
      { flag: 'wx' },
    );
    await atomic(path.join(run, 'progress.json'), state);
    return { run, ...state };
  });
}
export async function applyUpdate(
  workspace: string,
  run: string,
  confirmation: string,
) {
  workspace = path.resolve(workspace);
  run = await fs.realpath(path.resolve(run));
  inside(path.join(workspace, 'data/flight-updates'), run);
  const state = JSON.parse(
    await fs.readFile(path.join(run, 'progress.json'), 'utf8'),
  );
  assert.equal(state.version, 1);
  assert.equal(state.through, '2026-12-31');
  return locked(workspace, state.airline, async () => {
    const p = paths(workspace, state.airline),
      candidate = await fs.readFile(path.join(run, 'candidate.json'));
    assert.equal(
      hash(candidate),
      state.candidateSha256,
      'Candidate changed after preparation',
    );
    assert.equal(
      confirmation,
      state.candidateSha256,
      'Review confirmation does not match',
    );
    assert.equal(
      hash(await fs.readFile(path.join(run, 'before.json'))),
      state.originalSha256,
      'Original backup damaged',
    );
    assert.equal(
      hash(await fs.readFile(path.join(run, 'incoming.json'))),
      state.incomingSha256,
      'Incoming evidence changed',
    );
    assert.equal(
      hash(await fs.readFile(path.join(run, 'changes.json'))),
      state.changesSha256,
      'Review list changed',
    );
    if (state.sourceEvidence) {
      assert.deepEqual(
        await verifySource(
          workspace,
          state.sourceEvidence.file,
          state.incomingSha256,
          state.observationScope,
          state.airline,
        ),
        state.sourceEvidence,
        'Source audit changed',
      );
    }
    assert.deepEqual(
      await protectedHashes(workspace),
      state.protectedHashes,
      'Booking evidence/progress changed; prepare again',
    );
    const current = await fs.readFile(p.target),
      currentHash = hash(current);
    if (state.state === 'applied') {
      assert.equal(
        currentHash,
        state.appliedSha256,
        'Website data has changed since application',
      );
      return { ...state, repeatedApply: true };
    }
    const staged = JSON.parse(candidate.toString());
    validateSnapshot(staged, state.airline);
    const recomputed = compareSchedules(
      JSON.parse((await fs.readFile(path.join(run, 'before.json'))).toString()),
      JSON.parse(
        (await fs.readFile(path.join(run, 'incoming.json'))).toString(),
      ),
      state.airline,
      state.from,
      staged.importedAt,
      state.observationScope,
    );
    assert.deepEqual(
      staged,
      recomputed.staged,
      'Candidate differs from reviewed merge rules',
    );
    if (state.state === 'applying' && currentHash === state.candidateSha256) {
      const recovered = {
        ...state,
        state: 'applied',
        appliedAt: new Date().toISOString(),
        appliedSha256: currentHash,
        websiteDataChanged: true,
        recoveredAfterInterruption: true,
        productionRebuildRequired: true,
      };
      await atomic(path.join(run, 'progress.json'), recovered);
      return recovered;
    }
    assert.ok(['prepared', 'applying'].includes(state.state));
    assert.equal(
      currentHash,
      state.originalSha256,
      'Current data changed since review; prepare again',
    );
    try {
      await fs.writeFile(path.join(run, 'before-apply.json'), current, {
        flag: 'wx',
      });
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      assert.equal(
        hash(await fs.readFile(path.join(run, 'before-apply.json'))),
        state.originalSha256,
      );
    }
    await atomic(path.join(run, 'progress.json'), {
      ...state,
      state: 'applying',
      applyingAt: new Date().toISOString(),
    });
    await atomic(p.target, staged);
    const applied = {
      ...state,
      state: 'applied',
      appliedAt: new Date().toISOString(),
      appliedSha256: state.candidateSha256,
      websiteDataChanged: true,
      productionRebuildRequired: true,
    };
    await atomic(path.join(run, 'progress.json'), applied);
    return applied;
  });
}
export async function inspectUpdate(workspace: string, run: string) {
  workspace = path.resolve(workspace);
  run = await fs.realpath(path.resolve(run));
  inside(path.join(workspace, 'data/flight-updates'), run);
  const state = JSON.parse(
    await fs.readFile(path.join(run, 'progress.json'), 'utf8'),
  );
  const p = paths(workspace, state.airline),
    currentHash = hash(await fs.readFile(p.target));
  let lock: unknown = null;
  try {
    lock = JSON.parse(await fs.readFile(p.lock, 'utf8'));
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  return {
    run,
    state: state.state,
    summary: state.summary,
    originalDataStillPresent: currentHash === state.originalSha256,
    candidateDataPresent: currentHash === state.candidateSha256,
    bookingEvidenceUnchanged:
      JSON.stringify(await protectedHashes(workspace)) ===
      JSON.stringify(state.protectedHashes),
    lock,
    reviewFile: path.join(run, 'review.md'),
  };
}
