/** Preserve unknown source labels rather than guessing a numbered terminal. */
export function terminalLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^(INT|Intl\.|International)$/i.test(value)) return '國際線航廈';
  const number = value.match(/^(?:T)?([1-3])$/)?.[1];
  return number
    ? `第${({ '1': '一', '2': '二', '3': '三' } as const)[number as '1' | '2' | '3']}航廈`
    : value;
}
