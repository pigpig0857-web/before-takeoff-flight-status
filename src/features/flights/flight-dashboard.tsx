'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Flight, FlightResponse } from './types';
import { statusLabels } from './types';
import { displayDate, retrievedTime, summarizeDates } from '@/lib/time';
import { FlightCard } from './flight-card';
import { ReturnPanel } from './return-panel';
import { FlightDetails } from './flight-details';
import { FlightAssistant } from './flight-assistant';
import { DestinationHint } from './destination-hint';
import { CountryPicker } from './country-picker';
import { FutureTripPanel } from './future-trip-panel';
import { resolveDestination } from './destinations';
import { Icon } from '@/components/icon';
import {
  activeAirlines,
  taoyuanAirlines,
  findActiveAirline,
} from './airline-scope';
import { flightHasStaleData } from './result-state';
import {
  departureAirports,
  kaohsiungAirlineCodes,
  type DepartureCode,
} from './departure-airports';
interface Search {
  origin: DepartureCode;
  date: string;
  q: string;
  start: string;
  end: string;
  status: string;
}
export function FlightDashboard({
  today,
  countries: taoyuanCountries,
  khhCountries = [],
}: {
  today: string;
  countries: { code: string; name: string }[];
  khhCountries?: { code: string; name: string }[];
}) {
  const [form, setForm] = useState<Search>({
    origin: 'TPE',
    date: today,
    q: '',
    start: '00:00',
    end: '23:59',
    status: '',
  });
  const [data, setData] = useState<FlightResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [selected, setSelected] = useState<Flight | null>(null);
  const [selectedAirport, setSelectedAirport] = useState<string | null>(null);
  const [selectedAirline, setSelectedAirline] = useState('');
  const [limit, setLimit] = useState(30);
  const [tripMode, setTripMode] = useState<'oneway' | 'roundtrip'>('oneway');
  const [returnDate, setReturnDate] = useState(
    today <= '2026-12-31' ? today : '2026-12-31',
  );
  const [outbound, setOutbound] = useState<Flight | null>(null);
  const [tripComplete, setTripComplete] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const origin = departureAirports[form.origin];
  const countries = form.origin === 'KHH' ? khhCountries : taoyuanCountries;
  const airlines =
    form.origin === 'KHH'
      ? activeAirlines.filter((a) => kaohsiungAirlineCodes.includes(a.code))
      : taoyuanAirlines;
  const airlineNames = airlines.map((a) => a.name).join('、');
  const activeSearch = useRef<Search>(form);
  const search = useCallback(
    async (
      filters: Search,
      {
        userAction = false,
        background = false,
      }: {
        userAction?: boolean;
        background?: boolean;
      } = {},
    ) => {
      // A scheduled refresh must not interrupt an in-progress user query.
      if (background && controller.current) return;
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      if (background) {
        setRefreshing(true);
      } else {
        setLoading(true);
        setRefreshing(false);
        setError('');
      }
      setRefreshError('');
      if (userAction) {
        setTripComplete(false);
        setOutbound(null);
        setSubmitted(true);
        setLimit(30);
        setSelectedAirport(null);
        setSelectedAirline('');
      }
      try {
        const response = await fetch(
          `/api/flights?${new URLSearchParams({ ...filters })}`,
          { signal: request.signal, cache: 'no-store' },
        );
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error || '暫時無法完成查詢，請稍後重試。');
        if (request.signal.aborted) return;
        setData(result);
        setSelectedAirline((code) =>
          code &&
          result.flights.some((flight: Flight) => flight.airlineCode === code)
            ? code
            : '',
        );
        setSelectedAirport((airport) =>
          airport &&
          result.flights.some(
            (flight: Flight) => flight.destinationCode === airport,
          )
            ? airport
            : null,
        );
        activeSearch.current = filters;
      } catch (e) {
        if (!request.signal.aborted) {
          if (background) {
            setRefreshError(
              '自動更新暫時未完成，保留上次查詢結果。可按「重新查詢」。',
            );
          } else {
            setError(e instanceof Error ? e.message : '查詢失敗，請重試。');
          }
        }
      } finally {
        if (!request.signal.aborted && controller.current === request) {
          controller.current = null;
          if (background) setRefreshing(false);
          else setLoading(false);
        }
      }
    },
    [],
  );
  useEffect(() => {
    void search(activeSearch.current);
    return () => controller.current?.abort();
  }, [search]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (
        document.visibilityState === 'visible' &&
        !error &&
        data?.today &&
        activeSearch.current.date === (data?.today || today)
      )
        void search(activeSearch.current, { background: true });
    }, 60_000);
    return () => clearInterval(timer);
  }, [search, data?.today, today, error]);
  const field = (key: keyof Search, value: string) =>
    setForm((v) => ({ ...v, [key]: value }));
  // The dropdown reflects the visible query; it never adds a hidden country filter.
  const queryCountry = findActiveAirline(form.q)
    ? undefined
    : resolveDestination(form.q)?.countryCode;
  const selectedCountry = countries.some(
    (country) => country.code === queryCountry,
  )
    ? queryCountry || ''
    : '';
  const chooseCountry = (code: string) =>
    field('q', countries.find((country) => country.code === code)?.name || '');
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Read native form values too: browser autofill/time controls can commit on submit.
    const values = new FormData(event.currentTarget);
    const filters: Search = {
      ...form,
      q: String(values.get('q') ?? form.q),
      date: String(values.get('date') ?? form.date),
      start: String(values.get('start') ?? '00:00'),
      end: '23:59',
    };
    setForm(filters);
    const chosenReturnDate = String(values.get('returnDate') ?? returnDate);
    setReturnDate(chosenReturnDate);
    if (
      tripMode === 'roundtrip' &&
      (chosenReturnDate < filters.date || chosenReturnDate > '2026-12-31')
    ) {
      setError('回程日期需在去程日期之後或同日，且不晚於 2026/12/31。');
      return;
    }
    void search(filters, { userAction: true });
  };
  const chooseOrigin = (code: DepartureCode) => {
    const next = { ...form, origin: code, q: '', status: '' };
    setForm(next);
    setSelected(null);
    setData(null);
    void search(next, { userAction: true });
  };
  const showResults = submitted;
  const fetchedAt = data?.feeds.find((f) => f.kind === 'realtime')?.fetchedAt;
  const liveDates = data?.dates || [];
  const flightsForAirlineOptions = selectedAirport
    ? (data?.flights || []).filter(
        (flight) => flight.destinationCode === selectedAirport,
      )
    : data?.flights || [];
  const availableAirlineCodes = new Set(
    flightsForAirlineOptions.map((flight) => flight.airlineCode),
  );
  const availableAirlines = airlines.filter((airline) =>
    availableAirlineCodes.has(airline.code),
  );
  const airlineFlights = (data?.flights || []).filter(
    (flight) => !selectedAirline || flight.airlineCode === selectedAirline,
  );
  const visibleFlights = selectedAirport
    ? airlineFlights.filter(
        (flight) => flight.destinationCode === selectedAirport,
      )
    : airlineFlights;
  const staleVisibleCount = visibleFlights.filter((f) =>
    flightHasStaleData(f, data?.feeds || []),
  ).length;
  const chooseAirline = (code: string) => {
    setSelectedAirline(code);
    setLimit(30);
    setSelectedAirport((airport) =>
      airport &&
      data?.flights.some(
        (flight) =>
          flight.destinationCode === airport &&
          (!code || flight.airlineCode === code),
      )
        ? airport
        : null,
    );
  };
  const toggleAirport = (code: string) => {
    setSelectedAirport((current) => (current === code ? null : code));
    setLimit(30);
  };
  return (
    <>
      <header className="site-header">
        <a href="/" className="brand">
          <span className="brand-symbol">
            <Icon name="plane" size={23} />
          </span>
          <span>
            起飛之前<small>BEFORE TAKEOFF</small>
          </span>
        </a>
        <div className="header-meta">
          <span className="airport-chip">
            <span className="dot" />
            {origin.city}出發 · {origin.code}
          </span>
        </div>
      </header>
      <main className={tripComplete ? 'trip-complete' : undefined}>
        <section
          className="search-panel"
          id="flight-search"
          aria-label={`查詢${origin.city}出發航班`}
        >
          <div className="search-body">
            <div className="search-intro">
              <div>
                <span className="search-kicker">FLIGHT SEARCH · 航班查詢</span>
                <h1>今天想飛去哪裡？</h1>
                <p>選擇出發機場、目的地與日期，查看已收錄的預定航班。</p>
              </div>
              <div className="search-route-art" aria-hidden="true">
                <span>
                  {origin.code}
                  <small>{origin.city}出發</small>
                </span>
                <span className="search-route-line">
                  <Icon name="plane" size={20} />
                </span>
                <span>
                  ···<small>下一站</small>
                </span>
              </div>
            </div>
            <div className="form-field departure-choice">
              <label htmlFor="origin">出發機場</label>
              <select
                id="origin"
                name="origin"
                value={form.origin}
                onChange={(e) => chooseOrigin(e.target.value as DepartureCode)}
              >
                <option value="TPE">桃園國際機場 TPE</option>
                <option value="KHH">高雄國際機場 KHH</option>
              </select>
            </div>
            <form onSubmit={submit}>
              <div className="trip-options" style={{ gridColumn: '1 / -1' }}>
                <fieldset>
                  <legend>行程類型</legend>
                  <label>
                    <input
                      type="radio"
                      name="tripMode"
                      value="oneway"
                      checked={tripMode === 'oneway'}
                      onChange={() => {
                        setTripMode('oneway');
                        setOutbound(null);
                      }}
                    />
                    單程
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="tripMode"
                      value="roundtrip"
                      checked={tripMode === 'roundtrip'}
                      onChange={() => {
                        setTripMode('roundtrip');
                        setReturnDate((d) => (d < form.date ? form.date : d));
                        setOutbound(null);
                      }}
                    />
                    來回
                  </label>
                </fieldset>
              </div>
              <div className="form-field query-field">
                <label htmlFor="query">目的地（選填）</label>
                <div className="input-icon destination-input">
                  <Icon name="search" size={18} />
                  <input
                    id="query"
                    name="q"
                    type="search"
                    value={form.q}
                    onChange={(e) => field('q', e.target.value)}
                    maxLength={100}
                    placeholder="日本、東京、大阪"
                    autoComplete="off"
                  />
                  <CountryPicker
                    countries={countries}
                    value={selectedCountry}
                    onChange={chooseCountry}
                  />
                </div>
              </div>
              <div className="form-field date-field">
                <label htmlFor="date">
                  {tripMode === 'roundtrip' ? '去程日期' : '出發日期'} ·
                  台灣時間
                </label>
                <input
                  id="date"
                  name="date"
                  type="date"
                  required
                  min={data?.today || today}
                  max={tripMode === 'roundtrip' ? '2026-12-31' : undefined}
                  value={form.date}
                  onInput={(e) => field('date', e.currentTarget.value)}
                  onChange={(e) => field('date', e.target.value)}
                />
              </div>
              {tripMode === 'roundtrip' && (
                <div className="form-field return-date-field">
                  <label htmlFor="return-date">回程日期 · 當地時間</label>
                  <input
                    id="return-date"
                    name="returnDate"
                    type="date"
                    required
                    min={form.date}
                    max="2026-12-31"
                    value={returnDate}
                    onInput={(e) => {
                      setReturnDate(e.currentTarget.value);
                      setOutbound(null);
                    }}
                    onChange={(e) => {
                      setReturnDate(e.target.value);
                      setOutbound(null);
                    }}
                  />
                </div>
              )}
              <div className="form-field time-field">
                <label htmlFor="start">幾點之後出發</label>
                <input
                  id="start"
                  name="start"
                  type="time"
                  required
                  value={form.start}
                  onInput={(e) => field('start', e.currentTarget.value)}
                  onChange={(e) => field('start', e.target.value)}
                />
              </div>
              <button
                className="primary-button"
                type="submit"
                disabled={loading}
              >
                <Icon name={loading ? 'refresh' : 'search'} size={18} />
                {loading ? '查詢中' : '查詢航班'}
              </button>
            </form>
            {tripMode === 'roundtrip' && (
              <p className="trip-help">
                先查詢並選擇去程，再查看由同一抵達機場返回{origin.city}
                的航班。回程日期以海外出發地當地日期為準；已收錄部分回程班表，可搭不同航空公司，尚未涵蓋所有航線。
              </p>
            )}
            <div className="search-help">
              <span>
                <Icon name="info" size={15} />
                查詢所選時間起至當天 23:59
                的航班（含開始時間）；選國家會填入搜尋框，可在後面加上城市縮小範圍。
              </span>
            </div>
            {data && (
              <p className="coverage-note">
                {data.mode === 'demo' ? '示範日期' : '目前已取得資料的日期'}：
                {liveDates.length
                  ? summarizeDates(liveDates)
                  : '尚未取得有效班表'}
                。各航空公司的資料範圍不同，未涵蓋所有航班與目的地。
              </p>
            )}
          </div>
        </section>
        {error && (
          <div className="error-message" role="alert">
            <Icon name="info" />
            <span>
              <strong>查詢暫時無法完成</strong>
              <br />
              {error} 這不代表沒有航班。
            </span>
            <button onClick={() => void search(form, { userAction: true })}>
              重試
            </button>
          </div>
        )}
        {showResults &&
          data &&
          !loading &&
          !error &&
          (visibleFlights.length ? staleVisibleCount > 0 : data.stale) && (
            <div className="inline-warning stale-warning" role="status">
              {visibleFlights.length
                ? `${staleVisibleCount} 筆結果的部分資料需要重新核對。`
                : '部分來源需要重新核對。'}
              每筆班表核對時間可在航班卡查看，最新安排請向航空公司或機場確認。
            </div>
          )}
        <section
          className="results-section"
          aria-label="航班查詢結果"
          aria-busy={loading}
        >
          <div className="results-heading">
            <div>
              <span className="eyebrow">
                {showResults ? 'DEPARTURES' : '開始規劃'}
              </span>
              <h2>
                {showResults
                  ? data?.resultState === 'outside_coverage' && !error
                    ? '未來旅行查詢'
                    : '出發航班'
                  : '查航班，安排你的來回'}
              </h2>
              <p aria-live="polite">
                {loading
                  ? '正在取得航班資料…'
                  : error
                    ? '資料未能取得，請重試或至官方網站確認。'
                    : showResults && data
                      ? `${data.date} · ${displayDate(data.date)} · ${activeSearch.current.start}–${activeSearch.current.end}（台灣預定起飛時間）${data.covered ? ` · ${visibleFlights.length} 筆班號結果 · ${new Set(visibleFlights.map((f) => f.airlineCode)).size} 家航空公司${selectedAirport ? ` · 抵達 ${selectedAirport}` : ''}` : ''}`
                      : '目的地、航空公司與兩地時間，一次看清楚。'}
              </p>
            </div>
            {showResults && data?.covered && !error && (
              <div className="result-filters">
                <label className="status-filter">
                  航空公司
                  <select
                    aria-label="篩選航空公司"
                    value={selectedAirline}
                    disabled={loading}
                    onChange={(event) => chooseAirline(event.target.value)}
                  >
                    <option value="">全部航空公司</option>
                    {availableAirlines.map((airline) => (
                      <option key={airline.code} value={airline.code}>
                        {airline.name} {airline.code}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="status-filter">
                  狀態
                  <select
                    aria-label="篩選航班狀態"
                    value={form.status}
                    disabled={loading}
                    onChange={(e) => {
                      const next = { ...form, status: e.target.value };
                      setForm(next);
                      void search(next, { userAction: true });
                    }}
                  >
                    <option value="">全部狀態</option>
                    {Object.entries(statusLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </div>
          {showResults && data?.covered && !loading && !error && (
            <DestinationHint
              origin={form.origin}
              query={activeSearch.current.q}
              flights={airlineFlights}
              selectedAirport={selectedAirport}
              onToggleAirport={toggleAirport}
            />
          )}
          {showResults &&
            data?.feeds.some(
              (feed) => feed.partial && feed.dates.includes(data.date),
            ) && (
              <p className="collected-results-note">
                此日期包含已收集的航空公司預定班表，未涵蓋所有航班；每筆來源可在詳情查看。共用班號可能對應同一實際航班。
              </p>
            )}
          {loading ? (
            <div className="skeleton-list" aria-label="載入中">
              {[1, 2, 3].map((i) => (
                <div key={i} className="skeleton" />
              ))}
            </div>
          ) : showResults && !error ? (
            data?.covered ? (
              visibleFlights.length ? (
                <>
                  <div id="flight-results" className="flight-list">
                    {visibleFlights.slice(0, limit).map((f) => (
                      <FlightCard
                        key={f.id}
                        flight={f}
                        onSelect={setSelected}
                        chosen={outbound?.id === f.id}
                        onChoose={
                          tripMode === 'roundtrip'
                            ? (flight) => {
                                setOutbound(flight);
                                setTimeout(
                                  () =>
                                    document
                                      .getElementById('return-results')
                                      ?.scrollIntoView({
                                        behavior: 'smooth',
                                        block: 'start',
                                      }),
                                  0,
                                );
                              }
                            : undefined
                        }
                      />
                    ))}
                  </div>
                  {limit < visibleFlights.length && (
                    <button
                      className="load-more"
                      onClick={() => setLimit((v) => v + 30)}
                    >
                      再顯示 30 筆（還有 {visibleFlights.length - limit} 筆）
                    </button>
                  )}
                </>
              ) : (
                <div className="empty-state">
                  <Icon name="search" size={32} />
                  <h3>
                    {data.resultState === 'partial'
                      ? '這個條件的資料尚未收集完整'
                      : '目前資料沒有符合條件的結果'}
                  </h3>
                  <p>
                    {data.resultState === 'partial'
                      ? `目前提供${airlineNames}已取得的班表。可調整航空公司、目的地或出發時間；查不到不代表沒有航班，請向航空公司確認。`
                      : '可調整目的地、起飛時間或狀態，或查看已取得的班號。這不代表當天沒有航班。'}
                  </p>
                  <button
                    onClick={() => {
                      setSelectedAirline('');
                      const next = {
                        ...form,
                        q: '',
                        start: '00:00',
                        end: '23:59',
                        status: '',
                      };
                      setForm(next);
                      void search(next, { userAction: true });
                    }}
                  >
                    查看當日已取得的班號 <Icon name="arrow" size={16} />
                  </button>
                </div>
              )
            ) : data?.resultState === 'outside_coverage' ? (
              <FutureTripPanel
                key={`${form.origin}:${data.date}:${activeSearch.current.q}:${activeSearch.current.start}:${activeSearch.current.end}`}
                filters={activeSearch.current}
              />
            ) : (
              <div className="empty-state unavailable">
                <Icon name="calendar" size={32} />
                <h3>這個日期的航班資料暫時無法取得</h3>
                <p>
                  這不代表當天沒有航班。 請稍後重新查詢，或到{origin.city}
                  機場官網確認。資料取得後才能判斷有沒有符合條件的航班。
                </p>
                <button
                  type="button"
                  onClick={() =>
                    void search(activeSearch.current, { userAction: true })
                  }
                >
                  重新取得資料
                </button>
                <a href={origin.url} target="_blank" rel="noreferrer">
                  前往機場官方查詢 ↗
                </a>
              </div>
            )
          ) : !showResults ? (
            <ol className="search-start-guide" aria-label="航班查詢步驟">
              <li>
                <span className="search-step-number" aria-hidden="true">
                  1
                </span>
                <div>
                  <h3>想去哪裡</h3>
                  <p>選桃園或高雄出發，輸入國家或城市。</p>
                </div>
              </li>
              <li>
                <span className="search-step-number" aria-hidden="true">
                  2
                </span>
                <div>
                  <h3>比較航班</h3>
                  <p>依日期查看航空公司、班號與起降時間。</p>
                </div>
              </li>
              <li>
                <span className="search-step-number" aria-hidden="true">
                  3
                </span>
                <div>
                  <h3>選好來回</h3>
                  <p>切換「來回」，選好兩段航班查看行程。</p>
                </div>
              </li>
            </ol>
          ) : null}
        </section>
        {tripMode === 'roundtrip' && outbound && !loading && !error && (
          <ReturnPanel
            key={`${outbound.id}|${returnDate}`}
            outbound={outbound}
            date={returnDate}
            onComplete={setTripComplete}
            onRestart={() => {
              setTripComplete(false);
              setOutbound(null);
              setSubmitted(false);
              setSelected(null);
              setTimeout(() => {
                document
                  .getElementById('flight-search')
                  ?.scrollIntoView({ block: 'start' });
                document
                  .getElementById('query')
                  ?.focus({ preventScroll: true });
              }, 0);
            }}
            onChangeOutbound={() => {
              setTripComplete(false);
              setOutbound(null);
              setTimeout(
                () =>
                  document
                    .getElementById('flight-results')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
                0,
              );
            }}
          />
        )}
        <section className="source-section" aria-label="資料來源與更新狀態">
          <div className="source-overview">
            <div>
              <span
                className={`dot ${data?.mode === 'demo' || data?.stale || !data?.covered ? 'amber' : ''}`}
              />
              <strong>
                {data?.mode === 'demo' ? '示範資料模式' : '已收錄的預定班表'}
              </strong>
            </div>
            <span>
              {origin.code === 'KHH' ? '班表資料取得：' : '本次查詢：'}
              {retrievedTime(
                (origin.code === 'KHH'
                  ? data?.feeds[0]?.fetchedAt
                  : fetchedAt) || null,
              )}
              （台灣時間）
            </span>
            <button
              className="refresh-button"
              disabled={loading}
              onClick={() => void search(activeSearch.current)}
              aria-label="重新查詢航班"
            >
              <Icon name="refresh" size={15} />
              重新查詢
            </button>
          </div>
          {data?.mode === 'demo' && (
            <p className="inline-warning">
              示範航班為虛構資料，不能作為旅行依據。
            </p>
          )}
          <p className="source-short">
            班表僅供行程規劃，非訂位資訊；查不到不代表沒有航班，最新安排請向航空公司確認。
          </p>
          {(refreshing || refreshError) && (
            <p className="source-short" role="status">
              {refreshing
                ? '正在背景更新航班資料，保留目前查詢結果。'
                : refreshError}
            </p>
          )}
          <details>
            <summary>資料來源與收錄範圍</summary>
            <p>目前收錄：{airlineNames}。各航線與日期的資料涵蓋程度不同。</p>
            <div className="feed-details">
              {data?.feeds.map((feed, index) => (
                <div key={`${feed.kind}-${feed.url}-${index}`}>
                  <a href={feed.url} target="_blank" rel="noreferrer">
                    {feed.label} ↗
                  </a>
                  <span
                    className={
                      feed.state === 'ready' ? 'feed-ready' : 'feed-warning'
                    }
                  >
                    {feed.state === 'ready'
                      ? '已取得'
                      : feed.state === 'stale'
                        ? '需要確認'
                        : '暫時無法取得'}
                  </span>
                  <p>
                    {feed.coverageDescription}{' '}
                    {feed.warning || '來源未提供明確更新時間。'} 取得時間：
                    {retrievedTime(feed.fetchedAt)}
                  </p>
                </div>
              ))}
            </div>
            <ul>
              {data?.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            <p>
              只列已收錄的{origin.city}
              出發客運班號；所有起飛時間皆為台灣時間。報到截止、登機時間與旅行文件要求，請向實際承運航空公司確認。
            </p>
            <a href={origin.guide} target="_blank" rel="noreferrer">
              {origin.city}機場官方出發指南 ↗
            </a>
          </details>
        </section>
      </main>
      <FlightAssistant hasTrip={Boolean(outbound)} onOpenTrip={() => {
        const target = document.getElementById(tripComplete ? 'trip-result-heading' : outbound ? 'return-results' : 'flight-search');
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (!outbound) { setTripMode('roundtrip'); document.getElementById('query')?.focus({ preventScroll: true }); }
        else if (tripComplete) document.getElementById('trip-result-heading')?.focus({ preventScroll: true });
      }} />
      <footer className="site-footer">
        <span>
          起飛之前 <small>BEFORE TAKEOFF</small>
        </span>
        <p>從{origin.city}出發，查看單程與來回班表。</p>
        <a href={origin.url} target="_blank" rel="noreferrer">
          {origin.city}機場官網 ↗
        </a>
      </footer>
      {selected && (
        <FlightDetails
          key={selected.id}
          flight={selected}
          stale={flightHasStaleData(selected, data?.feeds || [])}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
