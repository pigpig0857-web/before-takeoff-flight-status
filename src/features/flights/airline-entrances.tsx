import type { OfficialAirline } from './official-airlines';

const categories = [
  {
    id: 'low_cost',
    title: '廉價航空',
    tag: '依需求加購',
    description: '托運行李、餐點與選位可能另計，記得比較加購後的總價。',
  },
  {
    id: 'full_service',
    title: '傳統航空',
    tag: '確認票種內容',
    description: '服務依票種而異，訂票前確認行李額度、餐點與改票規則。',
  },
] as const;

export function AirlineEntrances({
  airlines,
}: {
  airlines: OfficialAirline[];
}) {
  const cards = (items: OfficialAirline[]) =>
    items.map((airline) => (
      <a
        key={airline.code}
        href={airline.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        <strong>{airline.name}</strong>
        <span>官網查詢 ↗</span>
      </a>
    ));
  return (
    <div className="official-airline-links">
      <h4>航空公司 · 官方查詢入口</h4>
      <p>所選目的地與日期是否有班、需否轉機，請到以下航空公司官網確認。</p>
      <div className="airline-groups">
        {categories
          .filter((category) =>
            airlines.some((airline) => airline.category === category.id),
          )
          .map((category) => {
            const items = airlines.filter(
              (airline) => airline.category === category.id,
            );
            return (
              <section
                key={category.id}
                className={`airline-group airline-group-${category.id}`}
                aria-label={`${category.title}查詢入口`}
              >
                <div className="airline-group-heading">
                  <h5>{category.title}</h5>
                  <span>{category.tag}</span>
                </div>
                <p>{category.description}</p>
                {items.length ? (
                  <>
                    <div className="airline-card-list">
                      {cards(items.slice(0, 3))}
                    </div>
                    {items.length > 3 && (
                      <details className="more-airlines">
                        <summary>
                          查看更多{category.title}（還有 {items.length - 3} 家）
                        </summary>
                        <div className="airline-card-list">
                          {cards(items.slice(3))}
                        </div>
                      </details>
                    )}
                  </>
                ) : (
                  <div className="airline-group-empty">
                    這個目的地尚未收錄{category.title}
                    入口。你也可以改查其他抵達機場，或向航空公司確認。
                  </div>
                )}
              </section>
            );
          })}
      </div>
      {airlines.some((airline) => airline.category === 'low_cost') && (
        <p className="trip-note airline-price-note">
          廉航不一定最便宜；把行李、選位與餐點費用一起比較，更容易找到適合的選擇。
        </p>
      )}
    </div>
  );
}
