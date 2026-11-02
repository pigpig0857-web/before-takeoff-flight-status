import test from 'node:test';
import assert from 'node:assert/strict';
import {
  restorePeachProgress,
  addPeachVerifiedCheck,
} from '../scripts/crawler/peach-resume-state.mjs';

const schedule = ['MM922', 'MM926', 'MM930'].map((number) => ({
  date: '2026-10-27',
  airport: 'OKA',
  number,
}));
const seed = {
  ...schedule[0],
  aircraft: 'A320',
  fetchedAt: '2026-10-12T03:00:00Z',
  evidenceSha256: 'a'.repeat(64),
};
const saved = schedule.map((row, i) => ({
  ...row,
  state: ['verified', 'query_failed', 'not_listed'][i],
  checkedAt: seed.fetchedAt,
  reason: i === 1 ? 'access_denied' : undefined,
}));
test('Resume preserves unrelated failure and unlisted states when adding a verified flight', () => {
  const { compiled, status } = restorePeachProgress(schedule, [seed], saved);
  assert.equal(
    addPeachVerifiedCheck(
      compiled,
      status,
      {
        ...schedule[1],
        aircraft: 'A320neo',
        fetchedAt: '2026-10-12T06:00:00Z',
      },
      'b'.repeat(64),
    ),
    true,
  );
  assert.deepEqual(compiled.get('2026-10-27|OKA|MM922'), seed);
  assert.equal(status.get('2026-10-27|OKA|MM926')!.state, 'verified');
  assert.deepEqual(status.get('2026-10-27|OKA|MM930'), saved[2]);
  assert.equal(saved[1].state, 'query_failed');
});
test('Resume never replaces completed evidence, even with a newer repeated observation', () => {
  const { compiled, status } = restorePeachProgress(schedule, [seed], saved);
  const before = structuredClone(status.get('2026-10-27|OKA|MM922'));
  assert.equal(
    addPeachVerifiedCheck(
      compiled,
      status,
      { ...seed, aircraft: 'A321LR', fetchedAt: '2026-10-12T07:00:00Z' },
      'c'.repeat(64),
    ),
    false,
  );
  assert.deepEqual(compiled.get('2026-10-27|OKA|MM922'), seed);
  assert.deepEqual(status.get('2026-10-27|OKA|MM922'), before);
});
test('Incomplete, duplicate and contradictory saved progress cannot start an import', () => {
  assert.throws(() => restorePeachProgress(schedule, [seed], saved.slice(1)));
  assert.throws(() => restorePeachProgress(schedule, [seed, seed], saved));
  assert.throws(() =>
    restorePeachProgress(
      schedule,
      [seed],
      saved.map((row) => ({ ...row, state: 'not_queried' })),
    ),
  );
  const { compiled, status } = restorePeachProgress(schedule, [seed], saved);
  assert.throws(() =>
    addPeachVerifiedCheck(
      compiled,
      status,
      { ...seed, number: 'MM999' },
      'x'.repeat(64),
    ),
  );
});
