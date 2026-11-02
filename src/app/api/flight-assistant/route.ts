import { NextResponse } from 'next/server';
import { getFlightDataset } from '@/server/services/flights';
import { filterFlights, parseFilters } from '@/features/flights/filter';
import { findReturnFlights } from '@/server/services/return-flights';
import { taipeiDate } from '@/lib/time';
import { generateFlightAssistantJson } from '@/server/services/vertex-ai';
import type { Flight } from '@/features/flights/types';
import type { ReturnFlight } from '@/features/flights/return-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const aiRequests = new Map<string, { count: number; resetAt: number }>();
function allowAiRequest(key: string, limit: number, now = Date.now()) {
  const bucket = aiRequests.get(key);
  if (!bucket || now >= bucket.resetAt) {
    aiRequests.set(key, { count: 1, resetAt: now + 3_600_000 });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

interface ParsedRequest {
  intent: 'search' | 'clarify' | 'unsupported';
  origin: 'TPE' | 'KHH' | null;
  outboundDate: string | null;
  returnDate: string | null;
  countryCode: string | null;
  destinationQuery: string | null;
  airlineCode: string | null;
  clarification: string;
}

const querySchema = {
  type: 'OBJECT',
  properties: {
    intent: { type: 'STRING', enum: ['search', 'clarify', 'unsupported'] },
    origin: { type: 'STRING', enum: ['TPE', 'KHH'] },
    outboundDate: { type: 'STRING' },
    returnDate: { type: 'STRING' },
    countryCode: { type: 'STRING' },
    destinationQuery: { type: 'STRING' },
    airlineCode: { type: 'STRING' },
    clarification: { type: 'STRING' },
  },
  required: [
    'intent',
    'origin',
    'outboundDate',
    'returnDate',
    'countryCode',
    'destinationQuery',
    'airlineCode',
    'clarification',
  ],
};

function localDate(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

function localTime(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

function conciseFlight(flight: Flight) {
  const arrivalZone = flight.arrivalTimeZone || 'Asia/Taipei';
  return {
    date: flight.date,
    airline: flight.airline,
    airlineCode: flight.airlineCode,
    number: flight.number,
    from: flight.origin || 'TPE',
    departure: localTime(flight.scheduledDeparture, 'Asia/Taipei'),
    to: flight.destinationCode,
    arrivalDate: localDate(
      flight.scheduledArrival || flight.scheduledDeparture,
      arrivalZone,
    ),
    arrival: flight.scheduledArrival
      ? localTime(flight.scheduledArrival, arrivalZone)
      : null,
    arrivalTimeZone: arrivalZone,
    source: flight.source,
  };
}

function conciseReturn(flight: ReturnFlight) {
  return {
    date: flight.date,
    airline: flight.airline,
    airlineCode: flight.airlineCode,
    number: flight.number,
    from: flight.departureAirport,
    departure: localTime(flight.departure, flight.departureTimeZone),
    departureTimeZone: flight.departureTimeZone,
    to: flight.arrivalAirport,
    arrivalDate: localDate(flight.arrival, flight.arrivalTimeZone),
    arrival: localTime(flight.arrival, flight.arrivalTimeZone),
    arrivalTimeZone: flight.arrivalTimeZone,
    arrivalDayOffset: flight.arrivalDayOffset,
  };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { message?: unknown };
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > 600) {
      return NextResponse.json(
        { error: '請輸入 1 到 600 字的航班問題。' },
        { status: 400 },
      );
    }
    if (process.env.K_SERVICE) {
      const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
      if (!allowAiRequest(`ip:${ip}`, 5) || !allowAiRequest('all', 60)) {
        return NextResponse.json(
          { error: 'AI 助理目前使用量較高，請稍後再試；一般航班查詢仍可使用。' },
          { status: 429 },
        );
      }
    }
    const today = taipeiDate();
    const parsed = await generateFlightAssistantJson<ParsedRequest>(
      [
        '你是繁體中文航班查詢網站的條件整理助手。只解析使用者意圖，不回答航班事實。',
        `今天是台灣日期 ${today}。查詢日期只允許今天至 2026-12-31。`,
        '預設出發機場 TPE；若使用者明確說高雄則 KHH。',
        '目的地要解析成 ISO 3166-1 alpha-2 國家/地區代碼；可辨識城市或機場時也放入 destinationQuery。',
        '若缺少明確日期或目的地，intent=clarify 並用繁體中文詢問必要資訊。',
        '回程日期可為空字串；沒說來回時視為只查去程。航班號若有指定，放入 airlineCode（兩碼航空代碼），不要猜。',
        '非航班查詢問題用 intent=unsupported。所有空值請用空字串。',
        `使用者問題：${message}`,
      ].join('\n'),
      querySchema,
    );

    if (parsed.intent === 'unsupported') {
      return NextResponse.json({
        type: 'message',
        message:
          '我可以幫你查已收錄的去程與回程班表。請告訴我出發機場、目的地和日期。',
      });
    }
    if (
      parsed.intent === 'clarify' ||
      !parsed.outboundDate ||
      !parsed.countryCode
    ) {
      return NextResponse.json({
        type: 'message',
        message:
          parsed.clarification ||
          '請告訴我出發日期和目的地國家或城市；例如「11 月 26 日從高雄去東京」。',
      });
    }
    if (
      parsed.outboundDate < today ||
      parsed.outboundDate > '2026-12-31' ||
      (parsed.returnDate &&
        (parsed.returnDate < parsed.outboundDate ||
          parsed.returnDate > '2026-12-31'))
    ) {
      return NextResponse.json({
        type: 'message',
        message:
          '目前只提供今天至 2026/12/31 的已收錄班表，請調整出發或回程日期。',
      });
    }

    const origin = parsed.origin || 'TPE';
    const dataset = await getFlightDataset(origin);
    const params = new URLSearchParams({
      origin,
      date: parsed.outboundDate,
      q: parsed.destinationQuery || '',
      country: parsed.countryCode,
      start: '00:00',
      end: '23:59',
    });
    const filters = parseFilters(params, today);
    const flights = filterFlights(dataset.flights, filters).filter(
      (flight) =>
        !parsed.airlineCode || flight.airlineCode === parsed.airlineCode,
    );
    const outbound = flights.slice(0, 12);
    const returns: ReturnFlight[] = [];
    const itineraryCandidates: { outbound: Flight; inbound: ReturnFlight }[] =
      [];
    if (parsed.returnDate) {
      for (const flight of flights) {
        if (!flight.scheduledArrival) continue;
        const returnParams = new URLSearchParams({
          date: parsed.returnDate,
          origin: flight.destinationCode,
          destination: origin,
          notBefore: flight.scheduledArrival,
        });
        const options = findReturnFlights(returnParams).flights;
        returns.push(...options);
        const preferred =
          options.find((option) => option.airlineCode === flight.airlineCode) ||
          options[0];
        if (preferred) {
          itineraryCandidates.push({ outbound: flight, inbound: preferred });
        }
      }
    }
    const uniqueReturns = [
      ...new Map(
        returns.map((flight) => [
          `${flight.date}|${flight.number}|${flight.departureAirport}|${flight.departure}`,
          flight,
        ]),
      ).values(),
    ].slice(0, 16);
    const itineraries = itineraryCandidates
      .sort(
        (a, b) =>
          Date.parse(a.outbound.scheduledDeparture) -
          Date.parse(b.outbound.scheduledDeparture),
      )
      .slice(0, 3)
      .map(({ outbound: departure, inbound }) => ({
        outbound: conciseFlight(departure),
        inbound: conciseReturn(inbound),
        stayNights: Math.max(
          0,
          Math.round(
            (Date.parse(`${inbound.date}T00:00:00Z`) -
              Date.parse(
                `${localDate(departure.scheduledArrival!, departure.arrivalTimeZone || 'Asia/Taipei')}T00:00:00Z`,
              )) /
              86_400_000,
          ),
        ),
        sameAirline: departure.airlineCode === inbound.airlineCode,
      }));

    return NextResponse.json({
      type: 'results',
      message: flights.length
        ? `找到 ${flights.length} 班符合條件的去程。${parsed.returnDate ? `回程日期 ${parsed.returnDate} 有 ${uniqueReturns.length} 個已收錄選項。` : '若要查回程，請再提供回程日期。'}`
        : `目前已收錄班表中，找不到 ${parsed.outboundDate} 從 ${origin} 前往該目的地的航班。查不到不代表當天沒有航班。`,
      query: {
        origin,
        outboundDate: parsed.outboundDate,
        returnDate: parsed.returnDate || null,
        countryCode: parsed.countryCode,
        destinationQuery: parsed.destinationQuery || null,
      },
      outbound: outbound.map(conciseFlight),
      returns: uniqueReturns.map(conciseReturn),
      itineraries,
      priceNote: '目前尚未連接即時票價；這些組合是已收錄班表，不代表仍有機位。',
      coverageNote:
        dataset.warnings[0] ||
        '班表為已收錄的預定資料，實際營運請以航空公司最新公告為準。',
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'AI 助理暫時無法回覆。';
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
