'use client';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/icon';
import { FlightJourneySummary } from './flight-journey-summary';
import type { Flight } from './types';
import type { ReturnFlight, ReturnResponse } from './return-types';
import { returnIdentity } from './return-types';
import { arrivalAirport, arrivalCity } from './destinations';
import { departureAirport, departureAirports } from './departure-airports';
import { zonedParts, durationLabel, calendarDayLabel } from './journey-time';
import { displayDate, retrievedTime } from '@/lib/time';
import { timetableReviewNotice } from './verification';

function localLabel(airport: string) {
  return ['TPE', 'KHH'].includes(airport)
    ? '台灣時間'
    : `${arrivalAirport(airport)?.country || airport}當地時間`;
}
function TimePoint({
  airport,
  instant,
  zone,
  label,
}: {
  airport: string;
  instant: string;
  zone: string;
  label: string;
}) {
  const time = zonedParts(instant, zone);
  const homeAirport =
    airport === 'TPE' || airport === 'KHH' ? departureAirports[airport] : null;
  return (
    <div className="flight-time-point">
      <span className="flight-time-label">
        {label} · {localLabel(airport)}
      </span>
      <strong className="flight-time-airport">
        {arrivalCity(airport) ||
          (airport === 'TPE'
            ? '桃園'
            : airport === 'KHH'
              ? '高雄'
              : airport)}{' '}
        <span>{airport}</span>
      </strong>
      <span className="flight-time-airport-name">
        {homeAirport?.name || arrivalAirport(airport)?.name || airport}
      </span>
      <time className="flight-time-date" dateTime={time.date}>
        {time.date.replaceAll('-', '/')}{' '}
        <span>{displayDate(time.date).slice(-2)}</span>
      </time>
      <time className="flight-time-clock" dateTime={instant}>
        {time.time}
      </time>
    </div>
  );
}
export function ReturnPanel({
  outbound,
  date,
  onChangeOutbound,
  onComplete,
  onRestart,
}: {
  outbound: Flight;
  date: string;
  onChangeOutbound: () => void;
  onComplete: (complete: boolean) => void;
  onRestart: () => void;
}) {
  const [data, setData] = useState<ReturnResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [airline, setAirline] = useState('');
  const [chosen, setChosen] = useState<ReturnFlight | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [expandedReturn, setExpandedReturn] = useState<string | null>(null);
  const home = departureAirport(outbound);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setChosen(null);
    setAirline('');
    setError('');
    setLoading(true);
    const params = new URLSearchParams({
      origin: outbound.destinationCode,
      destination: home.code,
      date,
      notBefore: outbound.scheduledArrival || '',
    });
    void fetch(`/api/return-flights?${params}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw Error(result.error || '回程資料暫時無法取得。');
        return result;
      })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    outbound.id,
    outbound.destinationCode,
    outbound.scheduledArrival,
    home.code,
    date,
    attempt,
  ]);
  const airlines = [
    ...new Map(
      (data?.flights || []).map((f) => [f.airlineCode, f.airline]),
    ).entries(),
  ];
  const rows = (data?.flights || []).filter(
    (f) => !airline || f.airlineCode === airline,
  );
  if (chosen)
    return (
      <TripResult
        outbound={outbound}
        inbound={chosen}
        onChangeOutbound={onChangeOutbound}
        onRestart={onRestart}
        onChangeReturn={() => {
          setChosen(null);
          onComplete(false);
          setTimeout(
            () =>
              document
                .getElementById('return-results')
                ?.scrollIntoView({ block: 'start' }),
            0,
          );
        }}
      />
    );
  return (
    <section
      id="return-results"
      className="return-panel"
      aria-label="回程航班"
      aria-busy={loading}
    >
      <div className="results-heading">
        <div>
          <span className="eyebrow">RETURN FLIGHTS</span>
          <h2>第二步 · 選擇回程</h2>
        </div>
        <button type="button" onClick={onChangeOutbound}>
          重新選擇去程
        </button>
      </div>
      <p className="return-outbound">
        已選去程：{outbound.date} · {outbound.airline} {outbound.number} ·{' '}
        {home.code} → {outbound.destinationCode}
      </p>
      {timetableReviewNotice(outbound) && (
        <p className="inline-warning">
          去程採用先前保存的班表，最新資料待核對；可先規劃行程，訂位前請向航空公司確認。
        </p>
      )}
      <p>
        回程：{date} ·{' '}
        {arrivalCity(outbound.destinationCode) || outbound.destinationCode}{' '}
        {outbound.destinationCode} → {home.city} {home.code}。可搭不同航空公司。
      </p>
      <p className="inline-warning">
        回程已收錄部分航空公司的預定班表，尚未涵蓋所有航線與日期；查不到不代表沒有航班。選擇僅供行程規劃，非訂位。
      </p>
      {loading ? (
        <p role="status">正在取得回程班表…</p>
      ) : error ? (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setAttempt((v) => v + 1)}>
            重新查詢回程
          </button>
        </div>
      ) : !data?.flights.length ? (
        <div className="empty-state">
          <h3>目前收錄資料中，這個日期沒有符合條件的回程</h3>
          <p>
            {data?.routeCollected
              ? '這不代表當天所有航空公司都沒有班機。可調整回程日期；去程抵達前的班次不會列出。'
              : '這條回程航線尚未收錄，請向航空公司確認。'}
          </p>
        </div>
      ) : (
        <>
          <label className="return-airline-filter">
            回程航空公司
            <select
              aria-label="篩選回程航空公司"
              value={airline}
              onChange={(e) => setAirline(e.target.value)}
            >
              <option value="">全部航空公司</option>
              {airlines.map(([code, name]) => (
                <option key={code} value={code}>
                  {name} {code}
                </option>
              ))}
            </select>
          </label>
          <p role="status">
            {rows.length} 筆已收錄回程班次 · 起飛時間為出發地當地時間
          </p>
          <div className="return-list">
            {rows.map((f) => {
              const selected =
                chosen && returnIdentity(chosen) === returnIdentity(f);
              const dep = zonedParts(f.departure, f.departureTimeZone);
              const arr = zonedParts(f.arrival, f.arrivalTimeZone);
              return (
                <article key={returnIdentity(f)} className="flight-card return-choice-card">
                  <div className={`airline-mark airline-${f.airlineCode}`}>{f.airlineCode}</div>
                  <div className="flight-identity"><h3>{f.number}</h3><span>{f.airline}</span></div>
                  <div className="flight-route">
                    <div className="departure-time">
                      <strong>{dep.time}</strong>
                      <span>{arrivalCity(f.departureAirport) || f.departureAirport} {f.departureAirport}</span>
                      <span>{localLabel(f.departureAirport)}</span>
                      <time className="return-choice-date" dateTime={dep.date}>{dep.date.replaceAll('-', '/')} {displayDate(dep.date).slice(-2)}</time>
                    </div>
                    <div className="route-trail"><span /><Icon name="plane" size={18} /><span /></div>
                    <div className="destination">
                      <strong>{departureAirports[f.arrivalAirport].city}</strong>
                      <span>抵達 {departureAirports[f.arrivalAirport].name} {f.arrivalAirport}</span>
                      <small className="card-arrival-note"><span>抵達</span><strong className="arrival-clock">{arr.time}</strong><span>台灣時間</span></small>
                      <time className="return-choice-date" dateTime={arr.date}>{arr.date.replaceAll('-', '/')} {arr.date !== dep.date ? ` · ${calendarDayLabel(arr.date, dep.date)}` : ''}</time>
                    </div>
                  </div>
                  <div className="flight-state"><span className="status-badge status-scheduled">預定班表</span><small>時間可能異動</small></div>
                  <button type="button" className="detail-button" aria-label={`查看回程 ${f.number} 航班詳情`} aria-expanded={expandedReturn === returnIdentity(f)} onClick={() => setExpandedReturn(expandedReturn === returnIdentity(f) ? null : returnIdentity(f))}>詳情<Icon name="arrow" size={17} /></button>
                  <button type="button" className="choose-outbound" aria-pressed={!!selected} onClick={() => { setChosen(f); onComplete(true); }}>{selected ? '已選擇回程' : `選擇回程 ${f.number}`}</button>
                  <p className="flight-source-note"><span>預定班表 · 非即時動態</span><span>資料取得：{retrievedTime(f.fetchedAt)}（台灣時間）</span></p>
                  {expandedReturn === returnIdentity(f) && <div className="return-choice-details">
                    <p>起飛至抵達 <strong>{durationLabel(f.minutes)}</strong></p>
                    <p>出發機場：{arrivalAirport(f.departureAirport)?.name || f.departureAirport} {f.departureAirport}</p>
                    <p>起飛時的台灣時間：{zonedParts(f.departure, 'Asia/Taipei').date.replaceAll('-', '/')} {zonedParts(f.departure, 'Asia/Taipei').time}</p>
                    <a href={f.url} target="_blank" rel="noreferrer">查看官方來源 ↗</a>
                    {f.sourceNotice && <p className="inline-warning">{f.sourceNotice}</p>}
                  </div>}
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function TripResult({
  outbound,
  inbound,
  onChangeOutbound,
  onChangeReturn,
  onRestart,
}: {
  outbound: Flight;
  inbound: ReturnFlight;
  onChangeOutbound: () => void;
  onChangeReturn: () => void;
  onRestart: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const home = departureAirport(outbound);
  const dep = zonedParts(inbound.departure, inbound.departureTimeZone);
  const arr = zonedParts(inbound.arrival, inbound.arrivalTimeZone);
  const taiwanDeparture = zonedParts(inbound.departure, 'Asia/Taipei');
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'start' });
  }, []);
  return (
    <section
      className="return-panel trip-result"
      aria-labelledby="trip-result-heading"
    >
      <div className="trip-result-heading">
        <span className="eyebrow">YOUR ROUND TRIP</span>
        <h2 id="trip-result-heading" ref={heading} tabIndex={-1}>
          你的來回行程
        </h2>
        <p>
          {home.city} {home.code} ↔{' '}
          {arrivalCity(outbound.destinationCode) || outbound.destination}{' '}
          {outbound.destinationCode}
        </p>
      </div>
      <p className="trip-result-notice">
        行程參考 ·
        尚未訂位。以下為已收錄的預定班表，請向航空公司確認最新時間及機位。
      </p>
      <div className="trip-result-actions" aria-label="調整行程">
        <button type="button" onClick={onChangeOutbound}>
          更換去程
        </button>
        <button type="button" onClick={onChangeReturn}>
          更換回程
        </button>
        <button type="button" onClick={onRestart}>
          重新搜尋
        </button>
      </div>
      <div className="trip-result-legs">
        <article
          className="return-card trip-result-leg"
          aria-label="已選去程航班"
        >
          <div className="trip-leg-heading">
            <span className="trip-leg-tag">去程</span>
            <h3>
              {outbound.airline} · {outbound.number}
            </h3>
            <span>預定班表</span>
          </div>
          <FlightJourneySummary flight={outbound} />
          {timetableReviewNotice(outbound) && (
            <p className="inline-warning">
              去程採用先前保存的班表，最新資料待核對；訂位前請向航空公司確認。
            </p>
          )}
          <div className="trip-leg-footer">
            <a
              href={outbound.collected?.url || home.url}
              target="_blank"
              rel="noreferrer"
            >
              查看去程來源 ↗
            </a>
          </div>
        </article>
        <article
          className="return-card trip-result-leg"
          aria-label="已選回程航班"
        >
          <div className="trip-leg-heading">
            <span className="trip-leg-tag">回程</span>
            <h3>
              {inbound.airline} · {inbound.number}
            </h3>
            <span>預定班表</span>
          </div>
          <div className="flight-journey-summary">
            <div className="flight-time-grid">
              <TimePoint
                airport={inbound.departureAirport}
                instant={inbound.departure}
                zone={inbound.departureTimeZone}
                label="回程出發"
              />
              <TimePoint
                airport={inbound.arrivalAirport}
                instant={inbound.arrival}
                zone={inbound.arrivalTimeZone}
                label="回到台灣"
              />
            </div>
          </div>
          <p className="return-duration">
            起飛至抵達 <strong>{durationLabel(inbound.minutes)}</strong>
            {arr.date !== dep.date && (
              <> · {calendarDayLabel(arr.date, dep.date)}</>
            )}
          </p>
          <p>
            起飛時的台灣時間：{taiwanDeparture.date.replaceAll('-', '/')}{' '}
            {taiwanDeparture.time}
          </p>
          <div className="trip-leg-footer">
            <a href={inbound.url} target="_blank" rel="noreferrer">
              查看回程來源 ↗
            </a>
            <span>
              資料取得：{retrievedTime(inbound.fetchedAt)}（台灣時間）
            </span>
          </div>
          {inbound.sourceNotice && (
            <p className="inline-warning">{inbound.sourceNotice}</p>
          )}
        </article>
      </div>
    </section>
  );
}
