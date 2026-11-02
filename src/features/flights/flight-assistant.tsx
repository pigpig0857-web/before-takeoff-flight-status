'use client';

import { useEffect, useRef, useState, type FormEvent, type PointerEvent } from 'react';

interface AssistantFlight {
  date: string;
  airline: string;
  airlineCode: string;
  number: string;
  from: string;
  departure: string;
  departureTimeZone?: string;
  to: string;
  arrival: string | null;
  arrivalDate?: string;
  arrivalTimeZone?: string;
  arrivalDayOffset?: number;
}

interface AssistantReply {
  type: 'message' | 'results';
  message: string;
  error?: string;
  query?: {
    origin: string;
    outboundDate: string;
    returnDate: string | null;
    countryCode: string;
    destinationQuery: string | null;
  };
  outbound?: AssistantFlight[];
  returns?: AssistantFlight[];
  itineraries?: {
    outbound: AssistantFlight;
    inbound: AssistantFlight;
    stayNights: number;
    sameAirline: boolean;
  }[];
  priceNote?: string;
  coverageNote?: string;
}

function FlightRows({
  title,
  flights,
}: {
  title: string;
  flights: AssistantFlight[];
}) {
  if (!flights.length) return null;
  const isReturn = title.includes('回程');
  return (
    <section className="assistant-flight-group">
      <h3>{title}</h3>
      <ul>
        {flights.map((flight, index) => (
          <li key={`${flight.date}-${flight.number}-${flight.from}-${index}`}>
            <strong>{flight.number}</strong>
            <span>{flight.airline}</span>
            <span>{flight.date.replaceAll('-', '/')}</span>
            <span>
              {isReturn ? '起飛' : '出發'} {flight.from} {flight.departure}
              {isReturn ? '（當地時間）' : '（台灣時間）'}
            </span>
            <span aria-hidden="true">→</span>
            <span>
              {isReturn ? '抵台' : '抵達'} {flight.to}{' '}
              {flight.arrivalDate
                ? `${flight.arrivalDate.replaceAll('-', '/')} `
                : ''}
              {flight.arrival || '抵達時間未收錄'}
              {isReturn ? '（台灣時間）' : '（當地時間）'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function FlightAssistant({ hasTrip = false, onOpenTrip }: { hasTrip?: boolean; onOpenTrip?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [panel, setPanel] = useState<'trip' | 'guide' | null>(null);
  const shell = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  function dismiss() { setExpanded(false); setOpen(false); setPanel(null); }
  useEffect(() => {
    function key(event: KeyboardEvent) { if (event.key === 'Escape') { dismiss(); toggle.current?.focus(); } }
    function outside(event: globalThis.PointerEvent) { if (event.target instanceof Node && !shell.current?.contains(event.target)) dismiss(); }
    function resize() { setPosition({ x: 0, y: 0 }); }
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', resize);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize); };
  }, []);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [message, setMessage] = useState('');
  const [reply, setReply] = useState<AssistantReply | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);

  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.moved && Math.hypot(dx, dy) > 6) current.moved = true;
    if (!current.moved) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const baseLeft = rect.left - position.x;
    const baseTop = rect.top - position.y;
    setPosition({
      x: Math.max(16 - baseLeft, Math.min(window.innerWidth - 16 - rect.width - baseLeft, current.originX + dx)),
      y: Math.max(16 - baseTop, Math.min(window.innerHeight - 24 - rect.height - baseTop, current.originY + dy)),
    });
  }

  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    suppressClick.current = drag.current.moved;
    drag.current = null;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!message.trim() || loading) return;
    setLoading(true);
    setError('');
    setReply(null);
    try {
      const response = await fetch('/api/flight-assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.trim() }),
      });
      const data = (await response.json()) as AssistantReply;
      if (!response.ok)
        throw new Error(data.error || '助理暫時無法回覆，請稍後再試。');
      setReply(data);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : '助理暫時無法回覆，請稍後再試。',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <section
      className={`flight-assistant${open ? ' is-open' : ''}`}
      ref={shell}
      aria-label="旅行工具"
    >
      {expanded && !open && !panel && (
        <nav className="travel-tools-menu" id="travel-tools-menu" aria-label="旅行工具選單">
          <div className="travel-tools-heading"><strong>旅行小幫手</strong><button type="button" onClick={dismiss} aria-label="關閉旅行工具">×</button></div>
          <button type="button" onClick={() => { setOpen(true); }}><span aria-hidden="true">✦</span><span><strong>AI 航班助理</strong><small>用一句話找航班、整理行程</small></span><span aria-hidden="true">→</span></button>
          <button type="button" onClick={() => { if (hasTrip && onOpenTrip) { dismiss(); onOpenTrip(); } else setPanel('trip'); }}><span aria-hidden="true">↔</span><span><strong>我的行程</strong><small>{hasTrip ? '查看目前選好的航班' : '查看已選的去程與回程'}</small></span><span aria-hidden="true">→</span></button>
          <button type="button" onClick={() => setPanel('guide')}><span aria-hidden="true">☷</span><span><strong>搭機指南</strong><small>報到、行李與轉機注意事項</small></span><span aria-hidden="true">→</span></button>
        </nav>
      )}
      {panel && (
        <div className="assistant-content travel-guide" id="travel-tools-panel" role="region" aria-label={panel === 'trip' ? '我的行程' : '搭機指南'}>
          <header className="assistant-header"><span><strong>{panel === 'trip' ? '我的行程' : '搭機指南'}</strong><small>{panel === 'trip' ? '你的選擇，集中在這裡' : '出發前，先了解下一步'}</small></span><button className="assistant-close" type="button" aria-label="關閉工具面板" onClick={dismiss}>×</button></header>
          {panel === 'trip' ? <><p>目前還沒有選擇航班。先切換「來回」，選擇去程與回程，就能查看完整行程。</p><button type="button" className="travel-primary" onClick={() => { dismiss(); onOpenTrip?.(); }}>開始規劃行程</button><small>目前保留本次頁面的選擇；重新整理後需重新選擇。</small></> : <>
            <ol><li><strong>報到與行李</strong><p>先查看航空公司的報到截止時間、行李額度與禁運物品；各公司規定不同。</p></li><li><strong>安檢與登機</strong><p>備妥旅行證件，依機場指示完成安檢與出境；登機門及登機時間請核對登機證與現場看板。</p></li><li><strong>需要轉機時</strong><p>先確認是否換機場或航廈、行李能否直掛，以及是否需要入境。分開購票可能需要重新報到，前段延誤也可能影響後段航班。</p></li></ol>
            <p className="travel-guide-note">這裡先提供流程說明；目前尚未提供自動轉機配對。入境與行李安排請向航空公司及機場確認。</p>
            <div className="travel-guide-links"><a href="https://www.taoyuan-airport.com/" target="_blank" rel="noreferrer">桃園機場官方資訊 ↗</a><a href="https://www.kia.gov.tw/" target="_blank" rel="noreferrer">高雄機場官方資訊 ↗</a></div>
          </>}
          <button type="button" className="travel-back" onClick={() => setPanel(null)}>← 返回工具選單</button>
        </div>
      )}
      {open && (
        <div className="assistant-content">
          <header className="assistant-header">
            <span className="assistant-mark" aria-hidden="true">
              ✦
            </span>
            <span>
              <strong>AI 航班助理</strong>
              <small>搜尋與整理來回行程</small>
            </span>
            <button
              className="assistant-close"
              type="button"
              aria-label="關閉航班助理"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </header>
          <p>例如：11 月 26 日從高雄去東京，12 月 3 日回來。</p>
          <form onSubmit={submit}>
            <textarea
              aria-label="輸入航班需求"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={600}
              rows={2}
              placeholder="告訴我出發地、目的地和日期…"
              required
            />
            <button type="submit" disabled={loading || !message.trim()}>
              {loading ? '查詢中…' : '開始查詢'}
            </button>
          </form>
          {loading && (
            <p className="assistant-status" role="status">
              正在整理條件並查詢已收錄班表…
            </p>
          )}
          {error && (
            <p className="assistant-error" role="alert">
              {error}
            </p>
          )}
          {reply && (
            <div className="assistant-reply" aria-live="polite">
              <p>{reply.message}</p>
              {reply.query && (
                <p className="assistant-query">
                  {reply.query.origin} 出發 ·{' '}
                  {reply.query.outboundDate.replaceAll('-', '/')}
                  {reply.query.returnDate
                    ? ` 往返至 ${reply.query.returnDate.replaceAll('-', '/')}`
                    : ''}
                  {reply.query.destinationQuery
                    ? ` · ${reply.query.destinationQuery}`
                    : ''}
                </p>
              )}
              {!!reply.itineraries?.length && (
                <section className="assistant-itineraries">
                  <h3>可搭配的來回行程</h3>
                  <p>{reply.priceNote}</p>
                  <ol>
                    {reply.itineraries.map((trip) => (
                      <li
                        key={`${trip.outbound.date}-${trip.outbound.number}-${trip.inbound.date}-${trip.inbound.number}`}
                      >
                        <strong>{trip.stayNights} 晚行程</strong>
                        {trip.sameAirline && (
                          <span className="assistant-trip-tag">
                            同家航空公司
                          </span>
                        )}
                        <span>
                          去程 · {trip.outbound.date.replaceAll('-', '/')}{' '}
                          {trip.outbound.number} · {trip.outbound.from}{' '}
                          {trip.outbound.departure}（台灣時間）→{' '}
                          {trip.outbound.to}{' '}
                          {trip.outbound.arrival || '抵達時間未收錄'}
                          （當地時間）
                        </span>
                        <span>
                          回程 · {trip.inbound.date.replaceAll('-', '/')}{' '}
                          {trip.inbound.number} · {trip.inbound.from}{' '}
                          {trip.inbound.departure}（當地時間）→{' '}
                          {trip.inbound.to}{' '}
                          {trip.inbound.arrival || '抵達時間未收錄'}（台灣時間）
                        </span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              <FlightRows title="去程選項" flights={reply.outbound || []} />
              <FlightRows title="回程選項" flights={reply.returns || []} />
              {reply.coverageNote && (
                <small className="assistant-coverage">
                  {reply.coverageNote}
                </small>
              )}
            </div>
          )}
        </div>
      )}
      <button
        ref={toggle}
        className="assistant-toggle"
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? '關閉旅行工具' : '開啟旅行工具；可拖曳移動'}
        style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          if (expanded) dismiss(); else setExpanded(true);
        }}
      >
        <span className="assistant-mark" aria-hidden="true">
          ✦
        </span>
        <span className="assistant-toggle-label">旅行工具</span>
      </button>
    </section>
  );
}
