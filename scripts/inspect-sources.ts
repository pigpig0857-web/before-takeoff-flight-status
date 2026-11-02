import fs from 'node:fs/promises';
import { parseCsv } from '../src/server/providers/csv';
import { SOURCE_URLS } from '../src/server/providers/taoyuan';
import { taipeiDate } from '../src/lib/time';
async function main() {
  for (const [kind, url] of Object.entries(SOURCE_URLS)) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const rows = parseCsv(text);
      const dateColumn = kind === 'realtime' ? '表訂日期' : '飛行日期';
      const dates = [
        ...new Set(
          rows.map((row) => row[dateColumn]?.slice(0, 10)).filter(Boolean),
        ),
      ].sort();
      const summary = {
        kind,
        checkedAt: new Date().toISOString(),
        today: taipeiDate(),
        rows: rows.length,
        headers: Object.keys(rows[0] || {}),
        firstDate: dates[0] || null,
        lastDate: dates.at(-1) || null,
        dates,
      };
      await fs.mkdir('data/source-samples', { recursive: true });
      await fs.writeFile(`data/source-samples/${kind}.csv`, text);
      await fs.writeFile(
        `data/source-samples/${kind}-report.json`,
        JSON.stringify(summary, null, 2),
      );
      console.log(JSON.stringify(summary, null, 2));
    } catch (error) {
      console.error(kind, error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
void main();
