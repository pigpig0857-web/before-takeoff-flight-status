import { randomUUID } from 'node:crypto';

export function pilotConfig(env = process.env, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000)
    .toISOString()
    .slice(0, 10);
  const date = env.PILOT_DATE || tomorrow;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date ||
    date < today ||
    date > '2026-12-31'
  )
    throw Error('Pilot date must be today through 2026-12-31 (Taipei).');
  const airports = (env.PILOT_AIRPORTS || 'NRT').split(',');
  if (
    airports.length > 4 ||
    new Set(airports).size !== airports.length ||
    airports.some((a) => !['NRT', 'ICN', 'BKK', 'SFO'].includes(a))
  )
    throw Error('Pilot supports distinct NRT, ICN, BKK, SFO only.');
  const bucket = env.STORAGE_BUCKET;
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
    throw Error('STORAGE_BUCKET required.');
  const id = randomUUID();
  return {
    date,
    airports,
    bucket,
    id,
    prefix: `eva-pilot/runs/${id}`,
    directory: `data/source-samples/crawler/cloud-pilot/${id}`,
  };
}

export function verifyPilotResult(receipt, analysis, airport, date) {
  if (
    receipt.status !== 'verified_requested_scope' ||
    receipt.query?.departure !== 'TPE' ||
    receipt.query?.arrival !== airport ||
    receipt.query?.date !== date ||
    analysis.departure !== 'TPE' ||
    analysis.arrival !== airport ||
    analysis.queryDate !== date ||
    analysis.scope !== 'requested_date' ||
    analysis.completeRequestedScope !== true ||
    analysis.scopeEntries < 1 ||
    analysis.verifiedDetails !== analysis.scopeEntries ||
    !Array.isArray(analysis.records) ||
    analysis.records.length !== analysis.scopeEntries ||
    analysis.records.some(
      (r) =>
        r.departure !== 'TPE' ||
        r.arrival !== airport ||
        !r.departureLocal?.startsWith(`${date}T`) ||
        r.marketingAirline !== 'BR' ||
        !/^BR\d+$/.test(r.number),
    )
  )
    throw Error('Pilot scope or detail verification failed.');
  return analysis.records.length;
}
