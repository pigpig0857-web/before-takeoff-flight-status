// RFC 4180-style CSV, including quoted commas/newlines, BOM and escaped quotes.
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (quoted) throw new Error('官方 CSV 引號格式不完整');
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  const headers = rows.shift()?.map((v) => v.trim());
  if (!headers?.length || new Set(headers).size !== headers.length)
    throw new Error('官方 CSV 欄位格式無效');
  return rows.map((values) => {
    if (values.length !== headers.length)
      throw new Error('官方 CSV 欄位數量改變');
    return Object.fromEntries(headers.map((key, i) => [key, values[i].trim()]));
  });
}
