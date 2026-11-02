import zones from './data/airport-timezones.json';
import { validDate, validTime } from '@/lib/time';

export function airportTimeZone(code: string): string | null {
  const additional: Record<string, string> = {
    DEL: 'Asia/Kolkata',
    MYJ: 'Asia/Tokyo',
    SHA: 'Asia/Shanghai',
    GMP: 'Asia/Seoul',
  };
  return (
    (zones.airports as Record<string, string>)[code] || additional[code] || null
  );
}

export function zonedParts(instant: string | number, zone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

export function utcOffset(instant: string | number, zone: string): string {
  return new Intl.DateTimeFormat('en', {
    timeZone: zone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(new Date(instant))
    .find((p) => p.type === 'timeZoneName')!
    .value.replace('GMT', 'UTC');
}

// Resolve local wall-clock time with IANA rules. A repeated or skipped DST hour
// cannot safely be guessed; return an error rather than choose an instant.
export function localArrival(
  date: string,
  time: string,
  zone: string,
): { iso: string; error: null } | { iso: null; error: string } {
  if (!validDate(date) || !validTime(time))
    return { iso: null, error: '請填寫有效的抵達日期與時間。' };
  try {
    const wall = Date.parse(`${date}T${time}:00Z`);
    const offsets = new Set<number>();
    for (const hours of [-36, -12, 0, 12, 36]) {
      const sample = wall + hours * 3600_000;
      const local = zonedParts(sample, zone);
      offsets.add(Date.parse(`${local.date}T${local.time}:00Z`) - sample);
    }
    const candidates = [...offsets]
      .map((offset) => wall - offset)
      .filter((instant) => {
        const local = zonedParts(instant, zone);
        return local.date === date && local.time === time;
      });
    if (candidates.length !== 1)
      return {
        iso: null,
        error: candidates.length
          ? '這個當地時間在夏令時間切換時出現兩次，請向航空公司確認 UTC 時差。'
          : '這個當地時間不存在，請核對夏令時間切換與訂位確認信。',
      };
    return { iso: new Date(candidates[0]).toISOString(), error: null };
  } catch {
    return { iso: null, error: '目前無法確認抵達機場的時區。' };
  }
}

export function planArrival(
  departure: string,
  date: string,
  time: string,
  zone: string,
) {
  const result = localArrival(date, time, zone);
  if (!result.iso) return { ...result, minutes: null };
  const minutes = (Date.parse(result.iso) - Date.parse(departure)) / 60_000;
  if (!Number.isFinite(minutes) || minutes <= 0)
    return {
      iso: null,
      minutes: null,
      error: '抵達時間必須晚於起飛時間；請核對當地日期與時差。',
    };
  if (minutes > 72 * 60)
    return {
      iso: null,
      minutes: null,
      error: '起飛至抵達超過 72 小時，請核對日期，或分段安排轉機行程。',
    };
  return { ...result, minutes };
}

export function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  return `${hours ? `${hours} 小時` : ''}${remainder ? ` ${remainder} 分鐘` : ''}`.trim();
}

export function calendarDayLabel(
  arrivalDate: string,
  departureDate: string,
): string {
  const days = Math.round(
    (Date.parse(`${arrivalDate}T00:00:00Z`) -
      Date.parse(`${departureDate}T00:00:00Z`)) /
      86400_000,
  );
  return days === 0
    ? '當地同日抵達'
    : `${days > 0 ? '+' : ''}${days} 天（當地日期）`;
}
