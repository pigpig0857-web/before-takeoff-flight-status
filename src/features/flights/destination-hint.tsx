import {
  arrivalAirport,
  destinationCountry,
  resolveDestination,
  taoyuanAirports,
} from './destinations';
import type { Flight } from './types';
import { Icon } from '@/components/icon';
import { findActiveAirline } from './airline-scope';

export function DestinationHint({
  query,
  country,
  flights,
  selectedAirport,
  onToggleAirport,
  origin = 'TPE',
}: {
  query: string;
  country?: string;
  flights: Flight[];
  selectedAirport: string | null;
  onToggleAirport: (code: string) => void;
  origin?: 'TPE' | 'KHH';
}) {
  if (findActiveAirline(query)) return null;
  const match =
    resolveDestination(query) ||
    resolveDestination(destinationCountry(country || '')?.name || '');
  if (!match || (country && match.countryCode && match.countryCode !== country))
    return null;
  const available = [
    ...new Set(flights.map((flight) => flight.destinationCode)),
  ]
    .map(arrivalAirport)
    .filter((airport) => airport !== undefined);
  // Country searches explain only airports in the selected date/time's results.
  // City searches with no results still explain the known TPE arrival airports.
  const airports = available.length
    ? available
    : origin === 'KHH' || match.kind === 'country'
      ? []
      : match.kind === 'airport'
        ? match.airports
        : match.airports.filter((a) => a.served);
  const fallback =
    origin === 'TPE' && match.kind === 'city' && !airports.length
      ? taoyuanAirports.filter(
          (a) => a.countryCode === match.countryCode && a.city === match.label,
        )
      : [];
  const displayed = airports.length ? airports : fallback;
  const heading =
    match.kind === 'country'
      ? `前往${match.label}的航班`
      : `去${match.country || ''}${match.label}，可以飛到哪裡？`;
  const cityOnly = flights.some(
    (flight) => flight.collected && !flight.destinationCode,
  );
  const list = (items: typeof displayed) =>
    items.map((airport) => (
      <button
        key={airport.code}
        type="button"
        className="arrival-airport-button"
        aria-pressed={selectedAirport === airport.code}
        aria-label={`${airport.city} ${airport.code} ${airport.name}`}
        aria-controls={available.length ? 'flight-results' : undefined}
        disabled={!available.some((item) => item.code === airport.code)}
        onClick={() => onToggleAirport(airport.code)}
      >
        <strong>
          {airport.city} <span>{airport.code}</span>
        </strong>
        <p>{airport.name}</p>
        {selectedAirport === airport.code && (
          <span className="airport-selection">
            <Icon name="check" size={14} /> 已選取 · 再點取消
          </span>
        )}
      </button>
    ));
  return (
    <aside className="destination-hint" aria-label="目的地機場說明">
      <div className="destination-hint-heading">
        <Icon name="pin" size={20} />
        <div>
          <h3>{heading}</h3>
          <p>
            {match.kind === 'country'
              ? available.length
                ? `這次查詢涵蓋 ${available.length} 個抵達機場；點選機場只看該機場航班，再次點選即可取消。`
                : cityOnly
                  ? '已找到這個國家的城市班表，來源未確認抵達機場，請核對航空公司。'
                  : '目前已取得的資料沒有符合結果；部分航線可能尚未收集。'
              : match.kind === 'airport'
                ? '目前只查詢這個抵達機場。輸入城市名稱可一起查詢服務該城市的其他機場。'
                : available.length
                  ? '已一起查詢這個城市的機場；點選機場只看該機場航班，再次點選即可取消。'
                  : cityOnly
                    ? '已找到城市班表，但來源沒有確認機場。以下機場僅供參考，請核對航空公司。'
                    : '目前資料沒有符合結果；以下為已知城市機場，不代表所選日期一定有班。'}
          </p>
        </div>
      </div>
      {displayed.length > 0 && (
        <div className="arrival-airports">{list(displayed)}</div>
      )}
      {selectedAirport && cityOnly && (
        <p className="airport-filter-note" role="status">
          目前只顯示抵達機場已確認的航班；取消選取後，可查看機場待確認的班表。
        </p>
      )}
      <p className="destination-source">
        機場與國家／地區對照依據{' '}
        <a
          href="https://ourairports.com/data/"
          target="_blank"
          rel="noreferrer"
        >
          OurAirports 開放資料 ↗
        </a>
        ；每筆航班的來源與取得時間可在詳情查看。
      </p>
    </aside>
  );
}
