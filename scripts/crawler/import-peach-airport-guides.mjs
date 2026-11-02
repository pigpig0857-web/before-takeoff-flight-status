import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve(process.argv[2] || '');
const receipt = JSON.parse(
  await fs.readFile(path.join(root, 'receipt.json'), 'utf8'),
);
const expected = {
  TPE: [
    'Departure (Terminal 1 1-3F)',
    'Arrival (Terminal 1 1-3F)',
    '第一航廈1–3樓',
    '第一航廈1–3樓',
  ],
  KIX: [
    'Departure (Terminal 2, International)',
    'Arrival（Terminal 2, International Arrival Gate）',
    '第二航廈（國際線）',
    '第二航廈（國際線）',
  ],
  NRT: [
    'Departure (4F, North Wing, Terminal 1)',
    'Arrival (1F, Terminal 1)',
    '第一航廈北翼4樓',
    '第一航廈1樓',
  ],
  HND: [
    'Departure (3F, Terminal 3)',
    'Arrival (2F, Terminal 3)',
    '第三航廈3樓',
    '第三航廈2樓',
  ],
  NGO: [
    'Departure (3F,Terminal 1)',
    'Arrival(2F,Terminal 1)',
    '第一航廈3樓',
    '第一航廈2樓',
  ],
  OKA: [
    'Departure (Passenger Terminal Building 3F)',
    'Arrival (Passenger Terminal Building 1F)',
    '旅客航廈3樓',
    '旅客航廈1樓',
  ],
};
if (
  receipt.sources.length !== 6 ||
  new Set(receipt.sources.map((s) => s.airport)).size !== 6
)
  throw new Error('Expected six unique airport guides');
const guides = [];
for (const source of receipt.sources) {
  const rule = expected[source.airport];
  const html = await fs.readFile(
    path.join(root, source.airport.toLowerCase() + '.html'),
  );
  if (
    !rule ||
    createHash('sha256').update(html).digest('hex') !== source.sha256 ||
    source.url !==
      'https://www.flypeach.com/en/lm/ai/airports/airportguide_international/' +
        source.airport.toLowerCase() ||
    !source.headings.includes(rule[0]) ||
    !source.headings.includes(rule[1])
  )
    throw new Error(`Guide validation failed: ${source.airport}`);
  guides.push({
    airport: source.airport,
    departureLabel: rule[2],
    arrivalLabel: rule[3],
    departureHeading: rule[0],
    arrivalHeading: rule[1],
    url: source.url,
    fetchedAt: source.fetchedAt,
    sha256: source.sha256,
    scope: 'airline_airport_guide',
  });
}
await fs.writeFile(
  'src/server/data/peach-airport-guides.json',
  JSON.stringify({ version: 1, guides }, null, 2) + '\n',
);
console.log(
  'Validated and imported 6 general airport guides; dated flight fields unchanged.',
);
