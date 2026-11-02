import type { Flight } from './types';
export interface TimetableVerification {
  state:
    'verified' | 'changed' | 'not_listed' | 'query_failed' | 'needs_review';
  attemptedAt: string;
  verifiedAt?: string;
  reason?: string;
  evidenceFile?: string;
}
export function timetableCheckedAt(flight: Flight): string | undefined {
  return (
    flight.timetableVerification?.verifiedAt || flight.collected?.fetchedAt
  );
}
export function timetableNeedsReview(flight: Flight): boolean {
  return Boolean(
    flight.timetableVerification &&
    flight.timetableVerification.state !== 'verified',
  );
}
/** Uncertain saved schedules must not look like confirmed scheduled service. */
export function timetableReviewNotice(
  flight: Flight,
): { label: string; description: string } | null {
  if (!flight.source.startsWith('collected_')) return null;
  switch (flight.timetableVerification?.state) {
    case 'not_listed':
      return {
        label: '班次待確認',
        description: '本次官方班表未列出此班次；是否取消或改班號尚未確認。',
      };
    case 'changed':
      return {
        label: '時間待確認',
        description: '本次來源起降時間與保存資料不同，目前顯示的時間尚待確認。',
      };
    case 'query_failed':
      return {
        label: '最新資料待核對',
        description: '目前顯示先前保存的班表，來源暫時無法完成最新核對。',
      };
    case 'needs_review':
      return {
        label: '資料待確認',
        description: '目前顯示先前保存的班表，本次來源資料仍需確認。',
      };
    default:
      return null;
  }
}
