import { NextResponse } from 'next/server';
export function GET() {
  // Liveness only: source health is reported independently by /api/flights.
  return NextResponse.json(
    { status: 'ok', service: 'flight-status' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
