import type { Flight } from '../../features/flights/types';
import { terminalLabel } from '../../features/flights/terminal';
import { departureAirport } from '../../features/flights/departure-airports';
import { statusLabels } from '../../features/flights/types';
import { clock, relativeDay } from '@/lib/time';
import { Icon } from '@/components/icon';
import { arrivalAirport, arrivalCity } from '../../features/flights/destinations';
import { zonedParts, calendarDayLabel } from '../../features/flights/journey-time';
import { FlightSourceNote } from './flight-source-note';
import { timetableReviewNotice } from '../../features/flights/verification';
export function FlightCard({
  flight,
  onSelect,
  onChoose,
  chosen = false,
}: {
  flight: Flight;
  onSelect: (flight: Flight) => void;
  onChoose?: (flight: Flight) => void;
  chosen?: boolean;
}) {
  const f = flight;
  const future = f.status === 'scheduled';
  const review = timetableReviewNotice(f);
  const arrival =
    f.scheduledArrival && f.arrivalTimeZone
      ? zonedParts(f.scheduledArrival, f.arrivalTimeZone)
      : null;
  return (
    <article className="flight-card">
      <div className={`airline-mark airline-${f.airlineCode}`}>
        {f.airlineCode}
      </div>
      <div className="flight-identity">
        <h3>{f.number}</h3>
        <span>{f.airline}</span>
      </div>
      <div className="flight-route">
        <div className="departure-time">
          <strong>{clock(f.scheduledDeparture)}</strong>
          <span>
            {departureAirport(f).city} {departureAirport(f).code}
          </span>
          <span>
            台灣時間{f.terminal ? ` · 出發${terminalLabel(f.terminal)}` : ''}
          </span>
        </div>
        <div className="route-trail">
          <span />
          <Icon name="plane" size={18} />
          <span />
        </div>
        <div className="destination">
          <strong>{arrivalCity(f.destinationCode) || f.destination}</strong>
          <span>
            {f.collected && !f.destinationCode
              ? '目的地機場待確認'
              : `抵達 ${arrivalAirport(f.destinationCode)?.name || f.destination}`}{' '}
            {f.destinationCode}
          </span>
          <small className="card-arrival-note">
            {arrival ? (
              <>
                <span>抵達</span>
                <strong className="arrival-clock">{arrival.time}</strong>
                <span>
                  {arrival.date !== f.date
                    ? `${calendarDayLabel(arrival.date, f.date)} · `
                    : ''}
                  當地時間
                </span>
              </>
            ) : (
              '抵達時間待確認'
            )}
          </small>
          {f.collected?.continuationAirport && (
            <small className="card-arrival-note">
              本卡為{departureAirport(f).city} → {f.destinationCode} 區段 ·
              同班號另有續程
            </small>
          )}
        </div>
      </div>
      <div className="flight-state">
        <span
          className={`status-badge status-${review ? 'changed' : f.status}`}
        >
          {review?.label || statusLabels[f.status]}
        </span>
        {review ? (
          <small>先前保存的時間 · 待確認</small>
        ) : f.reportedDeparture &&
          !future &&
          (f.reportedDeparture !== f.scheduledDeparture ||
            f.status === 'departed') ? (
          <small>
            {f.reportedTimeKind === 'actual' ? '實際' : '預估'}{' '}
            {relativeDay(f.reportedDeparture, f.date)}
            {clock(f.reportedDeparture)}
          </small>
        ) : (
          <small>
            {future
              ? '時間可能異動'
              : f.gate
                ? `登機門 ${f.gate}`
                : '登機門尚未公布'}
          </small>
        )}
      </div>
      <button
        className="detail-button"
        onClick={() => onSelect(f)}
        aria-label={`查看 ${f.number} 航班詳情`}
      >
        詳情
        <Icon name="arrow" size={17} />
      </button>
      <FlightSourceNote flight={f} compact />
      {onChoose && (
        <button
          type="button"
          className="choose-outbound"
          aria-pressed={chosen}
          disabled={
            !f.scheduledArrival ||
            !f.destinationCode ||
            f.status === 'cancelled' ||
              (!!review && f.timetableVerification?.state !== 'query_failed')
          }
          onClick={() => onChoose(f)}
        >
          {chosen ? '已選擇去程' : `選擇去程 ${f.number}`}
        </button>
      )}
      {review && (
        <p className="flight-card-review" role="note">
          {review.description}
        </p>
      )}
    </article>
  );
}
