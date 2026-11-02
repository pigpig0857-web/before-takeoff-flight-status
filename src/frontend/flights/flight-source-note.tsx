import type { Flight } from '../../features/flights/types';
import { flightHasStaleData } from '../../features/flights/result-state';
import { retrievedTime } from '@/lib/time';
import {
  timetableCheckedAt,
  timetableNeedsReview,
  timetableReviewNotice,
} from '../../features/flights/verification';

/** The time belongs to this row's saved schedule, not the whole airline feed. */
export function FlightSourceNote({
  flight,
  compact = false,
}: {
  flight: Flight;
  compact?: boolean;
}) {
  if (!flight.collected) return null;
  const savedOnly = flight.source.startsWith('collected_');
  const needsReview = flightHasStaleData(flight, []);
  const review = timetableReviewNotice(flight);
  return (
    <p className="flight-source-note" role="note">
      <span>
        {['collected_kix', 'collected_khh_oag'].includes(flight.source)
          ? '機場公開班表（OAG） · 非即時動態'
          : savedOnly
            ? '預定班表 · 非即時動態'
            : '抵達時間採預定班表'}
      </span>
      <span>
        {compact
          ? flight.timetableVerification?.verifiedAt
            ? '最近核對：'
            : '資料取得：'
          : `${savedOnly ? '班表' : '抵達班表'}核對：`}
        <time dateTime={timetableCheckedAt(flight)}>
          {retrievedTime(timetableCheckedAt(flight)!)}
        </time>
        （台灣時間）
      </span>
      {needsReview && (
        <span className="source-review-needed">
          {timetableNeedsReview(flight)
            ? '本次核對待確認 · 保留原班表'
            : '超過一天未重新核對'}
        </span>
      )}
      {review && !compact && (
        <span className="source-review-needed">{review.description}</span>
      )}
    </p>
  );
}
