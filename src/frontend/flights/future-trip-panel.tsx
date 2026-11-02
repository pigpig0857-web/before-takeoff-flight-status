'use client';

import { useState } from 'react';
import {
  destinationCountry,
  arrivalAirport,
  resolveDestination,
  taoyuanAirports,
} from '../../features/flights/destinations';
import { officialAirlines } from '../../features/flights/official-airlines';
import {
  activeAirlines,
  taoyuanAirlines,
  activeAirlineNames,
  findActiveAirline,
} from '../../features/flights/airline-scope';
import { AirlineEntrances } from './airline-entrances';
import type { FlightFilters } from '../../features/flights/types';
import { Icon } from '@/components/icon';
import { departureAirports, kaohsiungAirlineCodes } from '../../features/flights/departure-airports';

export function FutureTripPanel({ filters }: { filters: FlightFilters }) {
  const origin = departureAirports[filters.origin || 'TPE'];
  const country = destinationCountry(filters.country || '');
  const destination =
    (findActiveAirline(filters.q) ? null : resolveDestination(filters.q)) ||
    resolveDestination(country?.name || '');
  const match =
    country &&
    destination?.countryCode &&
    destination.countryCode !== country.code
      ? null
      : destination;
  const candidates =
    match?.kind === 'country'
      ? taoyuanAirports.filter(
          (airport) => airport.countryCode === match.countryCode,
        )
      : match?.airports.filter(
          (airport) => airport.served || match.kind === 'airport',
        ) || [];
  const originCandidates =
    origin.code === 'KHH'
      ? [
          'CTS',
          'KIX',
          'KMQ',
          'NRT',
          'OKA',
          'GMP',
          'PUS',
          'DAD',
          'KMJ',
          'OKJ',
          'FUK',
          'CJU',
          'SDJ',
          'NGO',
          'ISG',
        ].flatMap((code) => {
          const a = arrivalAirport(code);
          return a &&
            match &&
            (match.kind === 'country'
              ? a.countryCode === match.countryCode
              : match.airports.some((m) => m.code === code))
            ? [a]
            : [];
        })
      : candidates;
  const airports = originCandidates.filter(
    (airport) => !country || airport.countryCode === country.code,
  );
  const [airportCode, setAirportCode] = useState(
    airports.length === 1 ? airports[0].code : '',
  );
  const [copyMessage, setCopyMessage] = useState('');
  const airport = airports.find((entry) => entry.code === airportCode);
  const airlines = officialAirlines.filter((airline) =>
    origin.code === 'KHH'
      ? kaohsiungAirlineCodes.includes(airline.code)
      : taoyuanAirlines.some((active) => active.code === airline.code),
  );
  const conditions = [
    `出發機場：${origin.name} ${origin.code}${origin.code === 'TPE' ? '（請勿選台北松山 TSA）' : ''}`,
    `出發日期：${filters.date}`,
    `希望起飛時段：${filters.start}–${filters.end}（台灣時間）`,
    ...(country ? [`目的地國家／地區：${country.name}`] : []),
    airport
      ? `抵達機場：${airport.city}／${airport.name} ${airport.code}`
      : filters.q
        ? `目的地：${filters.q}`
        : country
          ? `目的地：${country.name}`
          : '目的地：請先選擇想去的國家或城市',
  ].join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(conditions);
      setCopyMessage('已複製，前往官網後可參考這些條件填寫。');
    } catch {
      setCopyMessage('目前無法自動複製，請選取下方文字手動複製。');
    }
  };

  return (
    <aside className="future-trip-panel" aria-label="未來旅行查詢指引">
      <div className="future-trip-heading">
        <Icon name="calendar" size={24} />
        <div>
          <span className="future-trip-tag">先規劃你的旅程</span>
          <h3>這個日期尚未取得可查詢的班表</h3>
          <p>
            {origin.city}出發目前提供
            {origin.code === 'KHH'
              ? taoyuanAirlines
                  .filter((a) => kaohsiungAirlineCodes.includes(a.code))
                  .map((a) => a.name)
                  .join('、')
              : activeAirlineNames}
            已取得的資料。這不代表當天沒有航班，請到航空公司官網確認預定航班。
          </p>
        </div>
      </div>
      <div className="future-trip-steps">
        <section aria-labelledby="trip-airport-heading">
          <h4 id="trip-airport-heading">
            <span>1</span> 確認你要飛到哪個機場
          </h4>
          {airports.length ? (
            <>
              <p>
                前往{match?.country}
                {match?.kind === 'country' ? '' : match?.label}
                ，可先查以下機場；並非所選日期的航班結果。
              </p>
              <label htmlFor="arrival-airport">抵達機場</label>
              <select
                id="arrival-airport"
                value={airportCode}
                onChange={(event) => {
                  setAirportCode(event.target.value);
                  setCopyMessage('');
                }}
              >
                <option value="">選擇機場（可分別查詢比較）</option>
                {airports.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.city} · {entry.name}（{entry.code}）
                  </option>
                ))}
              </select>
              <p className="trip-note">
                機場選項只作為目的地說明，不保證該日有直飛；是否有班、需否轉機，請向航空公司確認。
              </p>
            </>
          ) : (
            <p>
              {!filters.q && !country
                ? '在上方輸入想去的國家或城市，例如日本東京、韓國首爾，再按查詢。'
                : match
                  ? '目前目的地資料沒有可提供的機場選項，請向航空公司確認抵達機場與轉機安排。'
                  : '若已有機票，直接到承運航空公司確認；若還在規劃，請在上方輸入國家或城市，以取得機場說明。'}
            </p>
          )}
        </section>
        <section aria-labelledby="trip-conditions-heading">
          <h4 id="trip-conditions-heading">
            <span>2</span> 帶著條件，到官網查航班
          </h4>
          <p>
            官網不會自動帶入條件。選擇「航班時刻表」或「訂票查詢」，填入日期及機場，再核對起飛時間。
          </p>
          <pre className="trip-conditions">{conditions}</pre>
          <button
            className="copy-conditions"
            type="button"
            onClick={() => void copy()}
          >
            複製查詢條件
          </button>
          <p className="copy-feedback" role="status">
            {copyMessage}
          </p>
          <p className="trip-note">
            訂票查詢只看結果即可，不需要付款；有航班也不代表仍有可售機位。
          </p>
        </section>
      </div>
      <AirlineEntrances key={airportCode || filters.q} airlines={airlines} />
    </aside>
  );
}
