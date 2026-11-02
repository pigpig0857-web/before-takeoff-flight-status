import type { Flight } from './types';
import { departureAirport } from './departure-airports';
import { arrivalAirport, arrivalCity } from './destinations';
import { clock, displayDate, relativeDay } from '@/lib/time';
import {
  airportTimeZone,
  zonedParts,
  durationLabel,
  calendarDayLabel,
} from './journey-time';
import { terminalLabel } from './terminal';
import { Icon } from '@/components/icon';

/** Primary card always uses published times; optional personal planning stays separate. */
export function FlightJourneySummary({ flight: f }: { flight: Flight }) {
  const origin = departureAirport(f);
  const airport = arrivalAirport(f.destinationCode);
  const zone = f.arrivalTimeZone || airportTimeZone(f.destinationCode);
  const arrival =
    f.scheduledArrival && zone ? zonedParts(f.scheduledArrival, zone) : null;
  const arrivalAtOrigin = arrival
    ? zonedParts(f.scheduledArrival!, 'Asia/Taipei')
    : null;
  const minutes = f.scheduledArrival
    ? (Date.parse(f.scheduledArrival) - Date.parse(f.scheduledDeparture)) /
      60000
    : null;
  const showDuration =
    minutes !== null && Number.isFinite(minutes) && minutes > 0;
  return (
    <section className="flight-journey-summary" aria-label="航班時間摘要">
      <div className="flight-time-grid">
        <div className="flight-time-point">
          <span className="flight-time-label">出發 · 台灣時間</span>
          <strong className="flight-time-airport">
            {origin.city} <span>{origin.code}</span>
          </strong>
          <span className="flight-time-airport-name">{origin.name}</span>
          <time className="flight-time-date" dateTime={f.date}>
            {f.date.replaceAll('-', '/')}{' '}
            <span>{displayDate(f.date).slice(-2)}</span>
          </time>
          <time className="flight-time-clock" dateTime={f.scheduledDeparture}>
            {clock(f.scheduledDeparture)}
          </time>
          {f.terminal && (
            <span className="flight-time-terminal">
              出發{terminalLabel(f.terminal)}
              {f.collected?.terminalReference?.basis ===
              'published_airline_airport_guide'
                ? '（指南參考）'
                : f.source.startsWith('collected_')
                  ? '（預排）'
                  : ''}
            </span>
          )}
          {f.reportedDeparture && f.status !== 'scheduled' && (
            <span className="flight-time-update">
              {f.reportedTimeKind === 'actual' ? '實際起飛' : '預估起飛'}{' '}
              {relativeDay(f.reportedDeparture, f.date)}
              {clock(f.reportedDeparture)}（台灣時間）
            </span>
          )}
        </div>
        <div className="flight-time-point">
          <span className="flight-time-label">
            抵達 ·{' '}
            {airport?.country ? `${airport.country}當地時間` : '當地時間'}
          </span>
          <strong className="flight-time-airport">
            {arrivalCity(f.destinationCode) || f.destination}{' '}
            <span>{f.destinationCode}</span>
          </strong>
          <span className="flight-time-airport-name">
            {airport?.name || '目的地機場待確認'}
          </span>
          {arrival ? (
            <>
              <time className="flight-time-date" dateTime={arrival.date}>
                {arrival.date.replaceAll('-', '/')}{' '}
                <span>{displayDate(arrival.date).slice(-2)}</span>
              </time>
              <time
                className="flight-time-clock"
                dateTime={f.scheduledArrival!}
              >
                {arrival.time}
              </time>
              {arrival.date !== f.date && (
                <span className="flight-day-change">
                  {calendarDayLabel(arrival.date, f.date)}
                </span>
              )}
              {arrivalAtOrigin && (
                <div className="flight-arrival-origin">
                  <span className="flight-arrival-origin-label">
                    抵達時的台灣時間
                  </span>
                  <span className="flight-arrival-origin-place">
                    {origin.city} {origin.code} · 台灣時間
                  </span>
                  <time dateTime={f.scheduledArrival!}>
                    <span>{arrivalAtOrigin.date.replaceAll('-', '/')}</span>
                    <strong>{arrivalAtOrigin.time}</strong>
                  </time>
                </div>
              )}
            </>
          ) : (
            <strong className="flight-arrival-unknown">抵達時間待確認</strong>
          )}
          {f.arrivalTerminal && (
            <span className="flight-time-terminal">
              抵達{terminalLabel(f.arrivalTerminal)}
              {f.source.startsWith('collected_') ? '（預排）' : ''}
            </span>
          )}
        </div>
      </div>
      {showDuration && (
        <div className="flight-duration-summary">
          <Icon name="clock" size={17} />
          <span>
            {f.collected?.continuationAirport ? '本區段時長' : '起飛至抵達'}
          </span>
          <strong>{durationLabel(minutes!)}</strong>
        </div>
      )}
    </section>
  );
}
