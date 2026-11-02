'use client';
import { useEffect, useRef, useState } from 'react';
import type { Flight } from './types';
import { terminalLabel } from './terminal';
import { departureAirport } from './departure-airports';
import { statusLabels } from './types';
import { ArrivalPlanner } from './arrival-planner';
import { FlightJourneySummary } from './flight-journey-summary';
import { FlightSourceNote } from './flight-source-note';
import { Icon } from '@/components/icon';
import { arrivalAirport, arrivalCity } from './destinations';
import { guideSteps } from '@/features/departure-guide/guide';
import { retrievedTime } from '@/lib/time';
import {
  timetableCheckedAt,
  timetableNeedsReview,
  timetableReviewNotice,
} from './verification';
export function FlightDetails({
  flight,
  stale,
  onClose,
}: {
  flight: Flight;
  stale: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [stage, setStage] = useState(0);
  useEffect(() => {
    dialog.current?.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);
  const f = flight;
  const origin = departureAirport(f);
  const review = timetableReviewNotice(f);
  const guide = guideSteps[stage];
  return (
    <dialog
      ref={dialog}
      className="flight-dialog flight-query-dialog"
      onCancel={onClose}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) {
          const r = dialog.current.getBoundingClientRect();
          if (
            event.clientX < r.left ||
            event.clientX > r.right ||
            event.clientY < r.top ||
            event.clientY > r.bottom
          )
            onClose();
        }
      }}
      aria-labelledby="details-title"
    >
      <div className="dialog-top">
        <span className="eyebrow">航班資訊</span>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="關閉航班詳情"
        >
          <Icon name="close" />
        </button>
      </div>
      <h2 id="details-title">
        {f.number}
        <span>{f.airline}</span>
      </h2>
      <p className="dialog-route">
        {origin.city} {origin.code} <Icon name="arrow" size={17} />{' '}
        {arrivalCity(f.destinationCode) || f.destination}
        {arrivalAirport(f.destinationCode) &&
          ` · ${arrivalAirport(f.destinationCode)?.name}`}{' '}
        {f.destinationCode}
      </p>
      <span className={`status-badge status-${review ? 'changed' : f.status}`}>
        {review?.label || statusLabels[f.status]}
      </span>
      {review && (
        <div className="inline-warning" role="note">
          {review.description}
        </div>
      )}
      {((stale && !f.collected && !review) || f.source === 'demo') && (
        <div className="inline-warning">
          {f.source === 'demo'
            ? '這是虛構示範航班。'
            : '部分資料需要重新核對，請向航空公司確認最新安排。'}
        </div>
      )}
      {f.collected?.continuationAirport && (
        <div className="flight-segment-note" role="note">
          <strong>
            本卡只顯示{origin.city} →{' '}
            {arrivalCity(f.destinationCode) || f.destination} 的直飛區段
          </strong>
          <p>
            官網另列同班號由{arrivalCity(f.destinationCode) || f.destination}
            飛往{arrivalCity(f.collected.continuationAirport)}{' '}
            {f.collected.continuationAirport}
            ；以下抵達時間及時長不含該續程。請依訂位確認實際目的地。
          </p>
        </div>
      )}
      <FlightJourneySummary flight={f} />
      <div className="flight-summary-footer">
        <FlightSourceNote flight={f} compact />
        {f.collected && (
          <a
            className="flight-source-link"
            href={f.collected.url}
            target="_blank"
            rel="noreferrer"
          >
            查看來源 ↗
          </a>
        )}
      </div>
      <details className="flight-extra-disclosure">
        <summary>
          更多資訊<span>來源、機型與其他資料</span>
          <Icon name="arrow" size={18} />
        </summary>
        <div className="flight-extra-content">
          {f.collected && (
            <div className="collected-detail-note">
              <p>
                <strong>{f.collected.label}</strong>
              </p>
              <p>
                班表來源核對時間：{retrievedTime(timetableCheckedAt(f)!)}
                （台灣時間） 。
                {f.source.startsWith('collected_')
                  ? '這是預定班表，非即時航班動態。'
                  : '抵達時間採已保存的預定班表。'}
              </p>
              {f.timetableVerification && (
                <p>
                  原資料取得：{retrievedTime(f.collected.fetchedAt)}
                  （台灣時間）。
                  {timetableNeedsReview(f)
                    ? '本次自動核對未確認一致，仍保留原班表，請確認最新安排。'
                    : '已自動向公開班表來源核對，起降時間一致。'}
                </p>
              )}
              {f.collected.sourcePublishedAt && (
                <p>
                  班表發布日期：{f.collected.sourcePublishedAt}
                  ；起降時間依該季公布的適用日期整理。
                </p>
              )}
              {f.collected.sourceNotice && <p>{f.collected.sourceNotice}</p>}
              <p>
                {f.collected.detail
                  ? `本班次詳細資料取得於 ${retrievedTime(f.collected.detail.fetchedAt)}（台灣時間），已依班號與出發日期核對；預排航廈與機型可能異動。`
                  : f.bookingCheck
                    ? '本班次起降時間與預排機型已另查官方訂票頁；航廈等其他欄位尚未逐班確認。'
                    : f.bookingVerification?.state === 'query_failed'
                      ? '本航線此日期的訂票查詢未完成：官方拒絕存取。仍顯示已保存班表，不能據此判定無航班。'
                      : f.bookingVerification?.state === 'not_listed'
                        ? '本次訂票查詢未列出此班次，仍保留原班表；未列出不代表航班取消。'
                        : f.bookingVerification?.state === 'mismatch'
                          ? '目前起降時間與已核對的訂票證據不一致，詳細資料需要重新確認。'
                          : '已保存的預定資訊，詳細資料尚未逐筆核對；航班安排可能異動。'}
              </p>
              {!f.collected.airportConfirmed && !f.destinationCode && (
                <p>
                  來源只列目的地城市，機場尚待確認。
                  {f.collected.candidateAirport &&
                    `候選機場：${arrivalAirport(f.collected.candidateAirport)?.name || f.collected.candidateAirport} ${f.collected.candidateAirport}，請向航空公司核對。`}
                </p>
              )}
              {f.collected.codeshare && (
                <p>
                  共用班號 · 實際承運：
                  {f.collected.operatingAirline || '待確認'}{' '}
                  {f.collected.operatingNumber || ''}
                  。同一航班可能以不同班號列出。
                </p>
              )}
              <a href={f.collected.url} target="_blank" rel="noreferrer">
                查看班表來源 ↗
              </a>
              {f.collected.detail && (
                <a
                  className="detail-source-link"
                  href={f.collected.detail.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  查看本班次官網詳情 ↗
                </a>
              )}
              {f.collected.detail && (
                <p>若官網詳細頁無法開啟，請先到班表來源查詢該班次。</p>
              )}
            </div>
          )}
          <ArrivalPlanner flight={f} />
          {f.bookingCheck && (
            <div className="collected-detail-note">
              <strong>已核對此日期的樂桃官方訂票查詢</strong>
              <p>
                班號、{origin.city}起飛時間及當地抵達時間與已收集班表一致。
                查詢頁預排機型：
                {f.bookingCheck.aircraft}。
              </p>
              <p>
                取得於 {retrievedTime(f.bookingCheck.fetchedAt)}
                （台灣時間）；安排可能異動。
              </p>
              <a href={f.bookingCheck.url} target="_blank" rel="noreferrer">
                到樂桃重新查詢本班次 ↗
              </a>
            </div>
          )}
          <dl className="flight-facts">
            <div>
              <dt>實際承運航空公司</dt>
              <dd>
                {f.collected?.operatingAirline || '來源未提供，請核對訂位'}
              </dd>
            </div>
            <div>
              <dt>機型（預排）</dt>
              <dd>{f.aircraft || f.bookingCheck?.aircraft || '尚未取得'}</dd>
            </div>
          </dl>
          <dl className="location-grid">
            <div>
              <dt>
                出發航廈
                {f.status === 'scheduled'
                  ? f.collected?.terminalReference?.basis ===
                    'published_airline_airport_guide'
                    ? '（指南參考）'
                    : '（預排）'
                  : ''}
              </dt>
              <dd>{f.terminal ? terminalLabel(f.terminal) : '尚未取得'}</dd>
            </div>
            <div>
              <dt>報到櫃台{f.status === 'scheduled' ? '（預排）' : ''}</dt>
              <dd>{f.counter || '尚未公布'}</dd>
            </div>
            <div>
              <dt>登機門{f.status === 'scheduled' ? '（預排）' : ''}</dt>
              <dd>{f.gate || '尚未公布'}</dd>
            </div>
          </dl>
          {f.collected?.terminalReference && (
            <p className="detail-explanation">
              {f.collected.terminalReference.basis ===
              'published_airline_airport_guide'
                ? '航廈依航空公司的一般機場指南列示，尚未逐班確認。'
                : '航廈依官方班表的航線標示列示，安排可能異動。'}
              <a
                href={f.collected.terminalReference.url}
                target="_blank"
                rel="noreferrer"
              >
                查看航廈來源 ↗
              </a>
            </p>
          )}
          {f.airportGuidance && (
            <section
              className="airport-guide-reference"
              aria-label="樂桃官方航廈參考"
            >
              <h3>樂桃官方機場指南 · 航廈參考</h3>
              <p>
                以下為航空公司的一般機場安排，尚未逐筆確認本班次航廈；請核對訂位及機場公告。
              </p>
              <dl>
                <div>
                  <dt>
                    {origin.city} {origin.code} · 出發
                  </dt>
                  <dd>{f.airportGuidance.departure.departureLabel}</dd>
                  <a
                    href={f.airportGuidance.departure.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看{origin.city}指南 ↗
                  </a>
                </div>
                <div>
                  <dt>
                    {arrivalCity(f.destinationCode) || f.destination}{' '}
                    {f.destinationCode} · 抵達
                  </dt>
                  <dd>{f.airportGuidance.arrival.arrivalLabel}</dd>
                  <a
                    href={f.airportGuidance.arrival.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看抵達機場指南 ↗
                  </a>
                </div>
              </dl>
              <small>
                指南取得於 {retrievedTime(f.airportGuidance.arrival.fetchedAt)}
                （台灣時間）
              </small>
            </section>
          )}
          <p className="detail-explanation">
            航廈是你要前往的機場建築；報到櫃台辦理報到與託運，登機門則在完成安檢與證照查驗之後。位置可能異動，請核對現場看板。
          </p>
          <div className="unavailable-times">
            <Icon name="clock" size={18} />
            <div>
              <strong>報到截止與登機時間：請查閱航空公司／登機證</strong>
              <p>
                資料來源未提供這兩個時間，我們不以起飛時間推算。航班延誤也不代表可以晚到機場。
              </p>
            </div>
          </div>
          <section className="guide-section">
            <div className="guide-heading">
              <h3>你的下一步</h3>
              <span>一般出發指引</span>
            </div>
            {f.status === 'cancelled' || f.status === 'departed' ? (
              <div className="guide-body">
                <h4>
                  {f.status === 'cancelled'
                    ? '先聯絡航空公司確認安排'
                    : '資料顯示航班已起飛'}
                </h4>
                <p>
                  請確認你的訂位日期與航班；如有行程問題，向實際承運航空公司取得協助。
                </p>
              </div>
            ) : (
              <>
                <p className="muted">你目前在哪個階段？選一下就好。</p>
                <div className="stage-buttons">
                  {guideSteps.map((step, i) => (
                    <button
                      key={step.label}
                      className={i === stage ? 'active' : ''}
                      aria-pressed={i === stage}
                      onClick={() => setStage(i)}
                    >
                      {step.label}
                    </button>
                  ))}
                </div>
                <div className="guide-body">
                  <span className="step-number">0{stage + 1}</span>
                  <h4>{guide.title}</h4>
                  <p>{guide.description}</p>
                  <ul>
                    {guide.checklist.map((item) => (
                      <li key={item}>
                        <Icon name="check" size={16} />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}
          </section>
          <details className="more-details">
            <summary>更多航班資訊</summary>
            {f.collected?.detail && (
              <p>
                航廈與機型依該日期官網詳細頁核對；櫃台、登機門及即時異動以機場看板為準。
              </p>
            )}
            <p>
              來源動態：{f.sourceStatus || '來源未提供動態，不能據此判定準時。'}
            </p>
            <p>可能包含共用班號。報到請確認訂位中的實際承運航空公司。</p>
            <p>
              機場時區對照：
              <a
                href="https://openflights.org/data.php"
                target="_blank"
                rel="noreferrer"
              >
                OpenFlights
              </a>{' '}
              （ODbL）；依日期套用夏令時間規則。
            </p>
          </details>

          <div className="dialog-links">
            <a href={origin.url} target="_blank" rel="noreferrer">
              機場官方查詢 ↗
            </a>
            <a href={origin.guide} target="_blank" rel="noreferrer">
              機場出發指南 ↗
            </a>
          </div>
        </div>
      </details>
    </dialog>
  );
}
