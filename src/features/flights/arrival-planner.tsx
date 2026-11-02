'use client';

import { useState, type FormEvent } from 'react';
import type { Flight } from './types';
import { terminalLabel } from './terminal';
import { departureAirport } from './departure-airports';
import { clock, displayDate, relativeDay } from '@/lib/time';
import { officialAirlines } from './official-airlines';
import { arrivalAirport, arrivalCity } from './destinations';
import {
  airportTimeZone,
  calendarDayLabel,
  durationLabel,
  planArrival,
  utcOffset,
  zonedParts,
} from './journey-time';

interface ArrivalInput {
  date: string;
  time: string;
}

function readPlan(key: string): ArrivalInput | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (
      value &&
      typeof value === 'object' &&
      'date' in value &&
      'time' in value &&
      typeof value.date === 'string' &&
      typeof value.time === 'string'
    )
      return { date: value.date, time: value.time };
  } catch {
    /* Storage may be disabled; planning still works in the open card. */
  }
  return null;
}

export function ArrivalPlanner({ flight: f }: { flight: Flight }) {
  const origin = departureAirport(f);
  const key = `arrival-plan-v1:${f.id}`;
  const zone = f.arrivalTimeZone || airportTimeZone(f.destinationCode);
  const [input, setInput] = useState<ArrivalInput | null>(() => readPlan(key));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const savedArrival =
    f.scheduledArrival && zone ? zonedParts(f.scheduledArrival, zone) : null;
  const chosen = input || savedArrival;
  const usingSaved = Boolean(!input && savedArrival);
  const plan =
    chosen && zone
      ? planArrival(f.scheduledDeparture, chosen.date, chosen.time, zone)
      : null;
  const arrival = plan?.iso && zone ? zonedParts(plan.iso, zone) : null;
  const taiwan = plan?.iso ? zonedParts(plan.iso, 'Asia/Taipei') : null;
  const arrivalCountry = arrivalAirport(f.destinationCode)?.country;
  const airline = officialAirlines.find(
    (airline) => airline.code === f.airlineCode,
  );
  const lookup =
    f.airlineCode === 'CI' || f.airlineCode === 'AE'
      ? 'https://booking.china-airlines.com/FlightStatus/'
      : airline?.url;

  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!zone) return;
    const fields = new FormData(event.currentTarget);
    const next = {
      date: String(fields.get('arrivalDate') || ''),
      time: String(fields.get('arrivalTime') || ''),
    };
    const result = planArrival(
      f.scheduledDeparture,
      next.date,
      next.time,
      zone,
    );
    if (result.error) {
      setError(result.error);
      return;
    }
    setInput(next);
    setEditing(false);
    setError('');
    setCopyMessage('');
    try {
      sessionStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* See readPlan. */
    }
  };
  const clear = () => {
    setInput(null);
    setEditing(false);
    setError('');
    setCopyMessage('');
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* See readPlan. */
    }
  };
  const copy = async () => {
    const text = [
      `${f.number} ${f.airline}`,
      `出發：${origin.city} ${origin.code} ${f.date} ${clock(f.scheduledDeparture)}（台灣時間 UTC+08:00）`,
      f.reportedDeparture && f.status !== 'scheduled'
        ? `${f.reportedTimeKind === 'actual' ? '實際' : '預估'}起飛：${relativeDay(f.reportedDeparture, f.date)}${clock(f.reportedDeparture)}（台灣時間）`
        : '',
      `抵達：${arrivalCity(f.destinationCode) || f.destination} ${f.destinationCode}`,
      f.collected?.continuationAirport
        ? `本摘要僅含${origin.city}至 ${f.destinationCode} 區段；官網另列同班號續程至 ${f.collected.continuationAirport}，續程時間未包含。`
        : '',
      arrival && plan?.iso && zone
        ? `抵達時間：${arrival.date} ${arrival.time}（當地時間 ${utcOffset(plan.iso, zone)}；${usingSaved ? '已收集預定時間' : '由你填入'}，非即時動態）`
        : '抵達時間：尚未取得，請向航空公司確認',
      taiwan ? `抵達時的台灣時間：${taiwan.date} ${taiwan.time}` : '',
      plan?.minutes
        ? `起飛至抵達：${durationLabel(plan.minutes)}（依預定起飛與${usingSaved ? '已收集' : '你填入的'}抵達時間）`
        : '',
      `出發航廈：${terminalLabel(f.terminal) || '待確認'}`,
      `報到櫃台：${f.counter || '待確認'}；登機門：${f.gate || '待確認'}`,
      `抵達航廈（預排）：${terminalLabel(f.arrivalTerminal) || '未取得'}；機型（預排）：${f.aircraft || f.bookingCheck?.aircraft || '未取得'}`,
      f.bookingCheck
        ? `已核對此日期樂桃訂票查詢的起降時間與機型；取得於 ${f.bookingCheck.fetchedAt}；來源：${f.bookingCheck.url}`
        : '',
      f.airportGuidance
        ? `一般航廈參考（本班次尚未確認）：${origin.city} ${f.airportGuidance.departure.departureLabel} → ${f.destinationCode} ${f.airportGuidance.arrival.arrivalLabel}；來源：${f.airportGuidance.arrival.url}；取得於 ${f.airportGuidance.arrival.fetchedAt}`
        : '',
      f.collected?.detail
        ? `已核對本班次詳細資料；來源取得時間：${f.collected.detail.fetchedAt}`
        : '',
      f.collected
        ? `班表來源：${f.collected.label}；取得時間：${f.collected.fetchedAt}`
        : '',
      f.collected && !f.collected.airportConfirmed && !f.destinationCode
        ? '目的地機場尚待確認，請先核對訂位資料。'
        : '',
      f.status === 'cancelled' ? '航班已取消，請聯絡航空公司確認安排。' : '',
      f.source === 'demo' ? '虛構示範航班，不能作為旅行依據。' : '',
      '航班安排可能異動；抵達時間不等於離開機場的時間。',
    ]
      .filter(Boolean)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage('已複製航班摘要。');
    } catch {
      setCopyMessage('目前無法自動複製，請手動選取卡片上的資訊。');
    }
  };

  return (
    <section className="journey-planner" aria-label="出發與抵達時間">
      <div className="journey-timeline">
        <div className="journey-point">
          <span className="journey-label">
            出發 · {origin.city} {origin.code}
          </span>
          <span>{displayDate(f.date)}</span>
          <strong className="journey-clock">
            {clock(f.scheduledDeparture)}
          </strong>
          <span>預定起飛 · 台灣時間</span>
          <small>UTC+08:00</small>
          {f.reportedDeparture && f.status !== 'scheduled' && (
            <p className="journey-update">
              {f.reportedTimeKind === 'actual' ? '實際起飛' : '預估起飛'}{' '}
              <b>
                {relativeDay(f.reportedDeparture, f.date)}
                {clock(f.reportedDeparture)}
              </b>
            </p>
          )}
        </div>
        <div className="journey-point arrival-point">
          <span className="journey-label">
            抵達 · {arrivalCity(f.destinationCode) || f.destination}{' '}
            {f.destinationCode}
          </span>
          {arrival && plan?.iso && zone ? (
            <>
              <span className="journey-zone-label">
                {arrivalCountry
                  ? `${arrivalCountry}當地時間`
                  : '抵達地當地時間'}
              </span>
              <span>{displayDate(arrival.date)}</span>
              <strong className="journey-clock">{arrival.time}</strong>
              <span>
                {usingSaved ? '已收集的預定抵達' : '你填入的抵達時間'}
              </span>
              <small>
                {utcOffset(plan.iso, zone)} ·{' '}
                {calendarDayLabel(arrival.date, f.date)}
              </small>
              {taiwan && (
                <div className="arrival-taiwan-time">
                  <span className="journey-zone-label">換算台灣時間</span>
                  <time dateTime={plan.iso}>
                    <span>{displayDate(taiwan.date)}</span>
                    <strong>{taiwan.time}</strong>
                  </time>
                  <small>UTC+08:00 · 同一抵達時刻</small>
                </div>
              )}
              <small>
                抵達航廈（預排）：
                {terminalLabel(f.arrivalTerminal) ||
                  (f.collected?.detail ? '來源未提供' : '尚未取得')}
              </small>
            </>
          ) : (
            <>
              <strong className="arrival-missing">尚未取得</strong>
              <span>目前來源未提供抵達時間</span>
              <small>請查閱訂位確認信或航空公司</small>
            </>
          )}
        </div>
      </div>
      {arrival && plan?.minutes && (
        <div className="journey-duration">
          <strong>起飛至抵達 {durationLabel(plan.minutes)}</strong>
          <span>
            依預定起飛與{usingSaved ? '已收集的預定抵達' : '你填入的抵達時間'}
            換算，非即時預估；若有中停或轉機，時長也會包含停留。
          </span>
        </div>
      )}
      <div className="arrival-actions">
        {lookup && (
          <a href={lookup} target="_blank" rel="noreferrer">
            到{airline?.name || f.airline}確認抵達時間 ↗
          </a>
        )}
        {zone && (
          <button
            type="button"
            onClick={() => {
              setEditing(!editing);
              setError('');
            }}
            aria-expanded={editing}
            aria-controls="arrival-entry"
          >
            {arrival ? '修改抵達時間' : '填入訂位確認信的抵達時間'}
          </button>
        )}
      </div>
      {!lookup && (
        <p className="journey-note">
          請用 {f.number}、{f.date} 及 {f.destinationCode} 向{f.airline}
          查詢抵達時間。
        </p>
      )}
      {!zone && (
        <p className="journey-note">
          抵達機場的時區尚未確認，請以訂位確認信上的當地時間安排。
        </p>
      )}
      {editing && zone && (
        <form id="arrival-entry" className="arrival-entry" onSubmit={apply}>
          <h3>填入訂位確認信上的抵達時間</h3>
          <p>
            請填 {arrivalCity(f.destinationCode) || f.destination}{' '}
            當地的日期與時間，跨日航班也要核對日期。此資訊由你填入，不是航空公司即時資料。
          </p>
          <div className="arrival-inputs">
            <div>
              <label htmlFor="arrival-date">抵達日期 · 當地日期</label>
              <input
                id="arrival-date"
                name="arrivalDate"
                type="date"
                required
                defaultValue={chosen?.date || ''}
              />
            </div>
            <div>
              <label htmlFor="arrival-time">抵達時間 · 當地時間</label>
              <input
                id="arrival-time"
                name="arrivalTime"
                type="time"
                required
                defaultValue={chosen?.time || ''}
              />
            </div>
          </div>
          <p className="journey-note">僅供本分頁規劃使用；關閉分頁後不保留。</p>
          {error && (
            <p className="arrival-error" role="alert">
              {error}
            </p>
          )}
          <div className="arrival-form-actions">
            <button type="submit" className="arrival-apply">
              套用抵達時間
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              取消
            </button>
            {input && (
              <button type="button" onClick={clear}>
                {savedArrival ? '恢復收集的抵達時間' : '清除填入的時間'}
              </button>
            )}
          </div>
        </form>
      )}
      <div className="arrival-planning-note">
        <strong>安排抵達後的行程</strong>
        <p>
          接機、交通與飯店請依目的地的當地日期與時間安排，並預留入境、領行李及前往市區的時間。抵達航廈請核對航空公司或目的地機場。
        </p>
      </div>
      <div className="journey-copy">
        <button type="button" onClick={copy}>
          複製航班摘要
        </button>
        <span role="status">{copyMessage}</span>
      </div>
    </section>
  );
}
