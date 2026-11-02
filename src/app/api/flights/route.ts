import { NextRequest, NextResponse, after } from 'next/server';
import { maybeStartTimetableVerification } from '@/server/services/verification-startup';
import { getFlightDataset } from '@/server/services/flights';
import { filterFlights, parseFilters } from '@/features/flights/filter';
import { taipeiDate } from '@/lib/time';
import type { FlightResponse } from '@/features/flights/types';
import {
  flightResultState,
  flightHasStaleData,
} from '@/features/flights/result-state';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  let filters;
  try {
    filters = parseFilters(request.nextUrl.searchParams, taipeiDate());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '查詢條件無效。' },
      { status: 400 },
    );
  }
  after(async () => {
    try {
      await maybeStartTimetableVerification();
    } catch {
      console.error('[verification-startup] 背景核對未能啟動，保留原班表。');
    }
  });
  const dataset = await getFlightDataset(filters.origin || 'TPE');
  const flights = filterFlights(dataset.flights, filters);
  const relevantFeeds = dataset.feeds.filter((f) =>
    f.dates.includes(filters.date),
  );
  const response: FlightResponse = {
    ...dataset,
    flights,
    total: flights.length,
    resultState: flightResultState(dataset, filters.date, flights.length),
    date: filters.date,
    covered: dataset.dates.includes(filters.date),
    stale: flights.length
      ? flights.some((f) => flightHasStaleData(f, relevantFeeds))
      : relevantFeeds.some((f) => f.state === 'stale'),
  };
  return NextResponse.json(response, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
