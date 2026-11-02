import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Flight } from '@/features/flights/types';
import type { TimetableVerification } from '@/features/flights/verification';
export interface VerificationIdentity {
  origin?: 'TPE' | 'KHH';
  number: string;
  date: string;
  airport: string | null;
  departure: string;
  arrival: string | null;
  kind: string;
  url: string;
}
export function verificationKey(
  row: Pick<VerificationIdentity, 'number' | 'date' | 'airport' | 'origin'>,
) {
  return `${row.origin === 'KHH' ? 'KHH|' : ''}${row.date}|${row.number.replace(/^([A-Z0-9]{2})0+(?=\d)/, '$1')}|${row.airport}`;
}
export function verificationFingerprint(row: VerificationIdentity) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        verificationKey(row),
        row.departure,
        row.arrival,
        row.kind,
        row.url,
      ]),
    )
    .digest('hex');
}
export interface VerificationLedger {
  version: 1;
  updatedAt: string;
  entries: Record<string, TimetableVerification & { fingerprint: string }>;
}
export function enrichTimetableVerification(
  flight: Flight,
  ledger: VerificationLedger,
  now = Date.now(),
): Flight {
  if (!flight.collected || !flight.source.startsWith('collected_'))
    return flight;
  const identity: VerificationIdentity = {
    origin: flight.origin,
    number: flight.number,
    date: flight.date,
    airport: flight.destinationCode,
    departure: flight.scheduledDeparture,
    arrival: flight.scheduledArrival || null,
    kind: flight.source,
    url: flight.collected.url,
  };
  const check = ledger.entries[verificationKey(identity)];
  if (
    !check ||
    check.fingerprint !== verificationFingerprint(identity) ||
    ![
      'verified',
      'changed',
      'not_listed',
      'query_failed',
      'needs_review',
    ].includes(check.state) ||
    !Number.isFinite(Date.parse(check.attemptedAt)) ||
    Date.parse(check.attemptedAt) > now + 60000 ||
    (check.verifiedAt &&
      (!Number.isFinite(Date.parse(check.verifiedAt)) ||
        Date.parse(check.verifiedAt) > now + 60000 ||
        Date.parse(check.verifiedAt) > Date.parse(check.attemptedAt)))
  )
    return flight;
  if (
    check.state === 'verified' &&
    (!check.verifiedAt || check.verifiedAt !== check.attemptedAt)
  )
    return flight;
  return { ...flight, timetableVerification: check };
}
export async function applyTimetableVerifications(
  flights: Flight[],
): Promise<Flight[]> {
  try {
    const raw = await readFile(
      path.join(process.cwd(), 'data/automatic-verification/latest.json'),
      'utf8',
    );
    const ledger = JSON.parse(raw.replace(/^\uFEFF/, '')) as VerificationLedger;
    if (
      ledger.version !== 1 ||
      !ledger.entries ||
      typeof ledger.entries !== 'object'
    )
      throw new Error('Invalid verification ledger');
    return flights.map((flight) => enrichTimetableVerification(flight, ledger));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error('[timetable-verification] 核對紀錄無法讀取，保留原資料。');
    return flights;
  }
}
