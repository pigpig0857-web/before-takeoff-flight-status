import { NextRequest, NextResponse } from 'next/server';
import { findReturnFlights } from '@/server/services/return-flights';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  try {
    return NextResponse.json(findReturnFlights(request.nextUrl.searchParams), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : '回程查詢暫時無法完成。',
      },
      { status: 400 },
    );
  }
}
