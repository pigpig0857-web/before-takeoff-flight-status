export const TAIPEI_ZONE = 'Asia/Taipei';
export function taipeiDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TAIPEI_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
export function validTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
export function clock(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TAIPEI_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}
export function displayDate(date: string): string {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TAIPEI_ZONE,
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(`${date}T12:00:00+08:00`));
}
export function relativeDay(iso: string, scheduledDate: string): string {
  const day = taipeiDate(new Date(iso));
  return day === scheduledDate ? '' : `${day.slice(5).replace('-', '/')} `;
}
export function retrievedTime(iso: string | null): string {
  if (!iso) return '尚未取得';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TAIPEI_ZONE,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}
export function summarizeDates(dates: string[]): string {
  const sorted = [...new Set(dates)].sort();
  const groups: string[][] = [];
  for (const date of sorted) {
    const last = groups.at(-1);
    if (last && Date.parse(date) - Date.parse(last.at(-1)!) === 86400_000)
      last.push(date);
    else groups.push([date]);
  }
  return groups
    .map((group) =>
      group.length === 1
        ? group[0].replaceAll('-', '/')
        : `${group[0].replaceAll('-', '/')}～${group.at(-1)!.replaceAll('-', '/')}`,
    )
    .join('、');
}
