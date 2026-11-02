/** Import only visibly observed dated booking rows with matching official PDF times. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve(process.argv[2] || '');
const evidence = JSON.parse(
  await fs.readFile(path.join(root, 'booking-checks.json'), 'utf8'),
);
const snapshot = JSON.parse(
  await fs.readFile('src/server/data/peach-flights.json', 'utf8'),
);
const records = [],
  differences = [];
for (const query of evidence) {
  if (
    query.url !== 'https://booking.flypeach.com/en/' ||
    !Number.isFinite(Date.parse(query.fetchedAt))
  )
    throw new Error('Invalid booking source');
  const file = `${query.airport.toLowerCase()}-${query.date.replaceAll('-', '')}.txt`;
  const text = await fs.readFile(path.join(root, file), 'utf8');
  for (const row of query.rows) {
    const identity = row[0].match(/^(MM\d+)(A320neo|A321LR|A320)$/);
    const times = row[1].match(
      /^(\d{2}:\d{2})(\d{2}:\d{2})(?:\((\d{1,2})\/(\d{1,2})\))?$/,
    );
    const duration = row[2].match(/^(\d+)h(?:(\d+)m)?$/);
    if (
      !identity ||
      !times ||
      !duration ||
      !text.includes(`generic: ${identity[1]}`)
    )
      throw new Error('Booking result schema changed');
    const f = snapshot.records.find(
      (r) =>
        r.date === query.date &&
        r.airport === query.airport &&
        r.number === identity[1],
    );
    if (
      !f ||
      f.departure.slice(11, 16) !== times[1] ||
      f.arrival.slice(11, 16) !== times[2] ||
      (times[3]
        ? Number(f.arrival.slice(5, 7)) !== Number(times[3]) ||
          Number(f.arrival.slice(8, 10)) !== Number(times[4])
        : f.arrival.slice(0, 10) !== f.date) ||
      f.minutes !== Number(duration[1]) * 60 + Number(duration[2] || 0)
    ) {
      differences.push({
        query: { date: query.date, airport: query.airport },
        row,
        saved: f || null,
      });
      continue;
    }
    records.push({
      date: f.date,
      airport: f.airport,
      number: f.number,
      departure: f.departure,
      arrival: f.arrival,
      aircraft: identity[2],
      fetchedAt: query.fetchedAt,
      url: query.url,
      evidenceSha256: createHash('sha256').update(text).digest('hex'),
    });
  }
}
if (
  new Set(records.map((r) => `${r.date}:${r.airport}:${r.number}`)).size !==
  records.length
)
  throw new Error('Duplicate dated booking evidence');
const audit = {
  queries: evidence.length,
  matched: records.length,
  differences,
  generalTerminalsAreNotDatedVerification: true,
  all885FlightsChecked: false,
};
await fs.writeFile(
  path.join(root, 'import-audit.json'),
  JSON.stringify(audit, null, 2),
);
if (differences.length)
  throw new Error('Booking/PDF differences require review before import');
await fs.writeFile(
  'src/server/data/peach-booking-checks.json',
  JSON.stringify({ version: 1, records }, null, 2) + '\n',
);
console.log(JSON.stringify(audit, null, 2));
