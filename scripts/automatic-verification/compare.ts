import assert from 'node:assert/strict';
import type { SavedFlight } from '../../src/server/providers/collected';
import type { VerificationLedger } from '../../src/server/services/timetable-verification';
import {
  verificationFingerprint,
  verificationKey,
} from '../../src/server/services/timetable-verification';

export interface Observation {
  origin?: 'TPE' | 'KHH';
  number: string;
  date: string;
  airport: string;
  departure: string;
  arrival: string;
  minutes: number;
}
export function compareObservation(
  saved: SavedFlight[],
  observations: Observation[],
  at: string,
  evidenceFile: string,
  ledger: VerificationLedger,
  knownIdentities?: Set<string>,
) {
  assert.ok(Number.isFinite(Date.parse(at)));
  const seen = new Map<string, Observation>();
  for (const row of observations) {
    assert.ok(
      Number.isFinite(Date.parse(row.departure)) &&
        Number.isFinite(Date.parse(row.arrival)),
    );
    assert.equal(
      (Date.parse(row.arrival) - Date.parse(row.departure)) / 60000,
      row.minutes,
    );
    assert.ok(row.minutes > 0 && row.minutes <= 1440);
    assert.equal(row.departure.slice(0, 10), row.date);
    assert.ok(
      !seen.has(verificationKey(row)),
      'Duplicate source flight identity',
    );
    seen.set(verificationKey(row), row);
  }
  const counts = {
    verified: 0,
    changed: 0,
    not_listed: 0,
    added: [] as Observation[],
  };
  for (const r of saved) {
    const key = verificationKey(r),
      next = seen.get(key);
    const fingerprint = verificationFingerprint(r);
    const prior =
      ledger.entries[key]?.fingerprint === fingerprint
        ? ledger.entries[key]
        : undefined;
    const matches =
      next &&
      next.departure === r.departure &&
      next.arrival === r.arrival &&
      next.minutes === r.minutes;
    const state = matches ? 'verified' : next ? 'changed' : 'not_listed';
    counts[state]++;
    ledger.entries[key] = {
      fingerprint,
      state,
      attemptedAt: at,
      ...(matches
        ? { verifiedAt: at }
        : prior?.verifiedAt
          ? { verifiedAt: prior.verifiedAt }
          : {}),
      evidenceFile,
      ...(state !== 'verified' && {
        reason:
          state === 'changed'
            ? '公開來源起降時間有差異，保留原班表待確認。'
            : '本次來源未列出此班次，不能判定取消，保留原班表。',
      }),
    };
    seen.delete(key);
  }
  counts.added = [...seen.values()].filter(
    (r) => !knownIdentities?.has(verificationKey(r)),
  );
  return counts;
}
export function markPending(
  saved: SavedFlight[],
  ledger: VerificationLedger,
  at: string,
  reason: string,
  state: 'query_failed' | 'needs_review',
  evidenceFile?: string,
) {
  for (const r of saved) {
    const key = verificationKey(r),
      fingerprint = verificationFingerprint(r);
    const prior =
      ledger.entries[key]?.fingerprint === fingerprint
        ? ledger.entries[key]
        : undefined;
    ledger.entries[key] = {
      fingerprint,
      state,
      attemptedAt: at,
      reason,
      ...(prior?.verifiedAt && { verifiedAt: prior.verifiedAt }),
      ...(evidenceFile && { evidenceFile }),
    };
  }
}
