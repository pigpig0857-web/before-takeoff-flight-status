import type {
  FeedInfo,
  Flight,
  FlightDataset,
  FlightResultState,
} from './types';
import { timetableCheckedAt, timetableNeedsReview } from './verification';

/** A stale airline feed must not mark another airline's fresh details stale. */
export function flightHasStaleData(
  flight: Flight,
  feeds: FeedInfo[],
  now = Date.now(),
): boolean {
  const ownTimetable =
    flight.source.startsWith('collected_') && flight.collected;
  const savedTime = flight.collected
    ? Date.parse(timetableCheckedAt(flight) || '')
    : null;
  return (
    timetableNeedsReview(flight) ||
    feeds.some(
      (feed) =>
        feed.kind === flight.source &&
        feed.dates.includes(flight.date) &&
        (feed.state === 'unavailable' ||
          (!ownTimetable && feed.state === 'stale')),
    ) ||
    Boolean(
      flight.collected &&
      (!Number.isFinite(savedTime) || now - savedTime! > 24 * 3600_000),
    )
  );
}

// A feed failure inside the near-term window must not look like an empty timetable.
export function flightResultState(
  dataset: Pick<FlightDataset, 'today' | 'dates'> &
    Partial<Pick<FlightDataset, 'feeds'>>,
  date: string,
  count: number,
): FlightResultState {
  if (dataset.dates.includes(date)) {
    if (count) return 'matches';
    const feeds = dataset.feeds?.filter((feed) => feed.dates.includes(date));
    return feeds?.length && feeds.every((feed) => feed.partial)
      ? 'partial'
      : 'no_matches';
  }
  const tomorrow = new Date(`${dataset.today}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (
    date > tomorrow.toISOString().slice(0, 10) &&
    dataset.feeds?.some((feed) => feed.partial)
  )
    return 'outside_coverage';
  const horizon = [tomorrow.toISOString().slice(0, 10), ...dataset.dates]
    .sort()
    .at(-1)!;
  return date > horizon || date < dataset.today
    ? 'outside_coverage'
    : 'unavailable';
}
