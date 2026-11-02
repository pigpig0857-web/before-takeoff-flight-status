import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const snapshot = JSON.parse(await fs.readFile('src/server/data/eva-flights.json','utf8'));
const base = 'http://127.0.0.1:3000/api/flights';
const dates = [...new Set(snapshot.records.map(r=>r.date))].sort();
const checks = [];
for (const date of dates) {
  const response = await fetch(`${base}?${new URLSearchParams({date})}`,{signal:AbortSignal.timeout(30000)});
  assert.equal(response.status,200);
  const data = await response.json();
  assert.equal(data.total,data.flights.length);
  assert.ok(data.flights.every(f=>f.airlineCode==='BR'));
  assert.ok(data.feeds.every(f=>!['collected_ci','collected_trip'].includes(f.kind)));
  const expected = snapshot.records.filter(r=>r.date===date);
  const discrepancies = [];
  for (const record of expected) {
    const current = data.flights.find(f=>f.number===record.number && f.destinationCode===record.airport);
    if (!current) discrepancies.push(`${record.number} ${record.airport}: missing`);
    else if (current.source==='collected_eva') {
      for (const [published,saved] of [['scheduledDeparture','departure'],['scheduledArrival','arrival'],['terminal','terminal'],['arrivalTerminal','arrivalTerminal'],['aircraft','aircraft']])
        if (current[published]!==record[saved]) discrepancies.push(`${record.number} ${record.airport}: ${published}`);
      if (record.detail && current.collected?.detail?.url!==record.detail.url) discrepancies.push(`${record.number}: detail evidence`);
    }
  }
  checks.push({date,total:data.total,expected:expected.length,discrepancies});
  console.log(JSON.stringify(checks.at(-1)));
  assert.equal(discrepancies.length,0,`Website/snapshot mismatch ${date}`);
}
const queries = [
  {date:'2026-12-31',q:'日本東京',airport:'NRT'},
  {date:'2026-12-31',q:'韓國首爾',airport:'ICN'},
  {date:'2026-12-31',q:'美國舊金山',airport:'SFO'},
  {date:'2026-12-30',q:'印度新德里',airport:'DEL'},
  {date:'2026-11-26',q:'BR75',airport:'BKK'},
];
for (const query of queries) {
  const data = await (await fetch(`${base}?${new URLSearchParams({date:query.date,q:query.q})}`)).json();
  assert.ok(data.flights.length && data.flights.every(f=>f.destinationCode===query.airport));
  if (query.q==='BR75') assert.ok(data.flights.every(f=>f.collected?.continuationAirport==='AMS'));
}
const report = { checkedAt:new Date().toISOString(),dates:checks.length,snapshotRecords:snapshot.records.length,verifiedDetails:snapshot.records.filter(r=>r.detail).length,checks,queries };
await fs.writeFile('data/source-samples/crawler/eva-yearend-2026/full-details/website-check.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,checks:undefined,queries:undefined}));
