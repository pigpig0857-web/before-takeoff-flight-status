import fs from 'node:fs/promises';
import { parseCsv } from '../src/server/providers/csv';
import { SOURCE_URLS } from '../src/server/providers/taoyuan';

const airportUrl =
  'https://davidmegginson.github.io/ourairports-data/airports.csv';
const countryUrl =
  'https://davidmegginson.github.io/ourairports-data/countries.csv';
async function csv(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`資料下載失敗：${response.status}`);
  return parseCsv(await response.text());
}
async function main() {
  const [airportRows, countryRows, flights] = await Promise.all([
    csv(airportUrl),
    csv(countryUrl),
    csv(SOURCE_URLS.realtime),
  ]);
  const served = new Map<
    string,
    { code: string; city: string; english: string }
  >();
  const airlineDestinations = new Map<string, Set<string>>();
  for (const row of flights) {
    if (row['方向'] === 'D' && ['T1', 'T2'].includes(row['航廈'])) {
      served.set(row['往來地點'], {
        code: row['往來地點'],
        city: row['往來地點中文'],
        english: row['往來地點英文'],
      });
      const code = row['航空公司代碼'].trim();
      if (/^[A-Z0-9]{2}$/.test(code)) {
        const destinations = airlineDestinations.get(code) || new Set<string>();
        destinations.add(row['往來地點']);
        airlineDestinations.set(code, destinations);
      }
    }
  }
  if (served.size < 30) throw new Error('官方資料目的地數異常，保留原對照表。');
  // Prefer operating passenger-size airports if a retired airport reuses an IATA code.
  const airports = new Map<
    string,
    { code: string; name: string; countryCode: string; municipality: string }
  >();
  const rank = (type: string) =>
    [
      'large_airport',
      'medium_airport',
      'small_airport',
      'seaplane_base',
      'heliport',
    ].indexOf(type);
  airportRows.sort((a, b) => rank(a.type) - rank(b.type));
  for (const row of airportRows) {
    if (
      row.type === 'closed' ||
      !/^[A-Z]{3}$/.test(row.iata_code) ||
      airports.has(row.iata_code)
    )
      continue;
    airports.set(row.iata_code, {
      code: row.iata_code,
      name: row.name,
      countryCode: row.iso_country,
      municipality: row.municipality || '',
    });
  }
  const missing = [...served.keys()].filter((code) => !airports.has(code));
  if (missing.length)
    throw new Error(`機場資料缺少官方目的地：${missing.join(', ')}`);
  const regions = new Intl.DisplayNames(['zh-Hant'], { type: 'region' });
  const simplified = new Intl.DisplayNames(['zh-Hans'], { type: 'region' });
  const countries = countryRows
    .filter((row) => /^[A-Z]{2}$/.test(row.code))
    .map((row) => ({
      code: row.code,
      name: regions.of(row.code) || row.name,
      aliases: [row.name, simplified.of(row.code) || row.name],
    }));
  const destinationDir = 'src/features/flights/data';
  await fs.mkdir(destinationDir, { recursive: true });
  // Write only after every download and validation succeeds. No download occurs during a user search.
  await fs.writeFile(
    `${destinationDir}/airport-directory.json`,
    JSON.stringify(
      [...airports.values()].sort((a, b) => a.code.localeCompare(b.code)),
    ),
  );
  await fs.writeFile(
    `${destinationDir}/countries.json`,
    JSON.stringify(countries, null, 2),
  );
  await fs.writeFile(
    `${destinationDir}/taoyuan-destinations.json`,
    JSON.stringify(
      [...served.values()].sort((a, b) => a.code.localeCompare(b.code)),
      null,
      2,
    ),
  );
  await fs.writeFile(
    `${destinationDir}/airline-destinations.json`,
    JSON.stringify(
      Object.fromEntries(
        [...airlineDestinations]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([code, destinations]) => [code, [...destinations].sort()]),
      ),
      null,
      2,
    ),
  );
  await fs.writeFile(
    `${destinationDir}/sources.json`,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        airportUrl,
        countryUrl,
        flightsUrl: SOURCE_URLS.realtime,
        servedAirports: served.size,
        airportRecords: airports.size,
        license:
          'OurAirports: Public Domain. Flight availability: Taoyuan official feed.',
      },
      null,
      2,
    ),
  );
  console.log(
    `已建立 ${served.size} 個桃園出發目的地、${airports.size} 個機場的國家與城市對照。`,
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
