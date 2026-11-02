/** Compare visible booking rows with scheduled instants in the destination time zone. */
const airportNames = {
  KIX: 'Kansai',
  NRT: 'Narita',
  HND: 'Haneda',
  NGO: 'Chubu',
  OKA: 'Naha',
};
const zoned = (iso) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
};
export function comparePeachBookingQuery(query, text, expected) {
  if (
    query.url !== 'https://booking.flypeach.com/en/' ||
    !Number.isFinite(Date.parse(query.fetchedAt)) ||
    !/^2026-\d{2}-\d{2}$/.test(query.date) ||
    !airportNames[query.airport] ||
    !Array.isArray(query.rows) ||
    !query.rows.length
  )
    throw new Error('Invalid booking observation');
  const date = query.date.split('-').map(Number).join('/');
  const header = text.slice(
    text.indexOf('heading "1 stage"'),
    text.indexOf('button "Refine your search"'),
  );
  if (
    !header.includes('Taoyuan') ||
    !header.includes(airportNames[query.airport]) ||
    !text.includes(`button "${date} (`)
  )
    throw new Error('Result date/route evidence mismatch');
  if (
    new Date(query.date + 'T00:00:00Z').toISOString().slice(0, 10) !==
    query.date
  )
    throw new Error('Invalid calendar date');
  const records = [],
    differences = [],
    seen = new Set();
  for (const row of query.rows) {
    const identity = row[0]?.match(/^(MM\d+)(A320neo|A321LR|A320)$/);
    const times = row[1]?.match(
      /^(\d{2}:\d{2})(\d{2}:\d{2})(?:\((\d{1,2})\/(\d{1,2})\))?$/,
    );
    const duration = row[2]?.match(/^(\d+)h(?:(\d+)m)?$/);
    if (!identity || !times || !duration || seen.has(identity[1]))
      throw new Error('Invalid/duplicate booking row');
    seen.add(identity[1]);
    const start = text.indexOf(`- generic: ${identity[1]}\n`);
    const next = text.indexOf('- generic: MM', start + 1);
    const end =
      next < 0 ? text.indexOf('- heading "Fare Type Comparison"', start) : next;
    const block = text.slice(start, end < 0 ? undefined : end);
    if (
      start < 0 ||
      !block.includes(`generic: ${identity[2]}`) ||
      !block.includes(`generic: ${times[1]}`) ||
      !(
        block.includes(`generic: ${times[2]}`) ||
        block.includes(`text: ${times[2]}`)
      ) ||
      (times[3] && !block.includes(`(${times[3]}/${times[4]})`)) ||
      !block.includes(`text: ${duration[1]}h`) ||
      (duration[2] && !block.includes(`text: ${duration[2]}m`))
    )
      throw new Error('Visible row does not substantiate saved observation');
    const saved = expected.find(
      (f) =>
        f.number === identity[1] &&
        f.date === query.date &&
        f.airport === query.airport,
    );
    if (!saved) {
      differences.push({
        number: identity[1],
        reason: 'not_in_saved_schedule',
        row,
      });
      continue;
    }
    const localArrival = zoned(saved.arrival);
    const arrivalDate = times[3]
      ? `${query.date.slice(0, 4)}-${times[3].padStart(2, '0')}-${times[4].padStart(2, '0')}`
      : query.date;
    const publishedArrivalDate =
      times[3] && Number(times[3]) < Number(query.date.slice(5, 7))
        ? `${Number(query.date.slice(0, 4)) + 1}${arrivalDate.slice(4)}`
        : arrivalDate;
    if (
      saved.departure.slice(11, 16) !== times[1] ||
      localArrival.time !== times[2] ||
      localArrival.date !== publishedArrivalDate ||
      saved.minutes !== Number(duration[1]) * 60 + Number(duration[2] || 0)
    ) {
      differences.push({
        number: saved.number,
        reason: 'schedule_time_difference',
        row,
        savedDeparture: saved.departure,
        savedArrival: saved.arrival,
      });
      continue;
    }
    records.push({
      date: saved.date,
      airport: saved.airport,
      number: saved.number,
      departure: saved.departure,
      arrival: saved.arrival,
      aircraft: identity[2],
      fetchedAt: query.fetchedAt,
      url: query.url,
    });
  }
  const missing = expected
    .filter(
      (f) =>
        f.date === query.date &&
        f.airport === query.airport &&
        !seen.has(f.number),
    )
    .map((f) => ({
      date: f.date,
      airport: f.airport,
      number: f.number,
      state: 'not_listed',
      checkedAt: query.fetchedAt,
      reason:
        Date.parse(f.departure) < Date.parse(query.fetchedAt)
          ? 'scheduled_departure_before_query'
          : 'not_listed_in_booking_result',
    }));
  return { records, differences, missing };
}
