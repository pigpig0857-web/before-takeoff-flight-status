import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('data/flight-updates/integrate-new-airlines-2026-10-13T04-44-01.639Z');
const base='http://127.0.0.1:3000';
const saved=(await Promise.all(['eva','peach','tigerair','starlux'].map(async name=>JSON.parse(await readFile(`src/server/data/${name}-flights.json`,'utf8')))))
  .flatMap(s=>s.records).filter(r=>r.date>='2026-10-13');
const key=(date,number,airport)=>`${date}|${number.replace(/^([A-Z0-9]{2})0+(?=\d)/,'$1')}|${airport}`;
async function get(params) {
 const response=await fetch(`${base}/api/flights?${new URLSearchParams(params)}`,{signal:AbortSignal.timeout(30000)});
 assert.equal(response.status,200); const data=await response.json();assert.equal(data.total,data.flights.length);return data;
}
const checked=[],changes=[];const discovered=new Set();
for(const date of [...new Set(saved.map(r=>r.date))].sort()) {
 const data=await get({date});const refs=saved.filter(r=>r.date===date);
 const found=new Map(data.flights.map(f=>[key(f.date,f.number,f.destinationCode),f]));
 assert.ok(data.covered,date);assert.equal(found.size,data.flights.length,'No duplicate identities');
 assert.ok(data.flights.every(f=>f.date===date&&['BR','MM','IT','JX'].includes(f.airlineCode)));
 for(const r of refs) {
  const f=found.get(key(r.date,r.number,r.airport));assert.ok(f,`Missing saved flight ${r.number} ${date}`);
  if(Date.parse(f.scheduledDeparture)!==Date.parse(r.departure)) {
    assert.ok(['realtime','schedule'].includes(f.source));assert.equal(f.scheduledArrival||null,null);
    changes.push({date,number:f.number,airport:f.destinationCode,source:f.source,savedDeparture:r.departure,airportDeparture:f.scheduledDeparture});
  } else if(['collected_tigerair','collected_starlux'].includes(f.source)) {
    assert.equal(Date.parse(f.scheduledArrival),Date.parse(r.arrival));assert.equal(f.aircraft,r.aircraft);assert.equal(f.terminal,r.terminal);
  }
 }
 data.flights.forEach(f=>discovered.add(f.airlineCode));checked.push({date,count:data.total,savedMatched:refs.length});
 await writeFile(path.join(root,'api-progress.json'),JSON.stringify({state:'checking',datesComplete:checked.length,last:date}));
}
assert.deepEqual([...discovered].sort(),['BR','IT','JX','MM']);
const tokyo=await get({date:'2026-12-31',q:'日本東京'});assert.equal(tokyo.total,13);
const late=await get({date:'2026-12-31',q:'日本東京',start:'15:00'});
assert.ok(late.flights.every(f=>f.scheduledDeparture.slice(11,16)>='15:00'));
const airport=await get({date:'2026-12-31',q:'NRT'});assert.ok(airport.flights.every(f=>f.destinationCode==='NRT'));
for(const [q,code] of [['星宇','JX'],['虎航','IT']]) {
 const data=await get({date:'2026-12-31',q});assert.ok(data.total);assert.ok(data.flights.every(f=>f.airlineCode===code));
}
const korea=await get({date:'2026-11-26',q:'韓國'});assert.ok(korea.flights.some(f=>f.airlineCode==='IT'));
const prague=await get({date:'2026-12-30',q:'捷克'});assert.ok(prague.flights.some(f=>f.airlineCode==='JX'&&f.destinationCode==='PRG'));
const outside=await get({date:'2027-01-01',q:'星宇'});assert.equal(outside.total,0);assert.equal(outside.resultState,'outside_coverage');
const result={state:'passed',checkedAt:new Date().toISOString(),dailyQueries:checked.length,totalQueries:checked.length+8,
  savedRecordsMatched:checked.reduce((n,d)=>n+d.savedMatched,0),newRecordsMatched:saved.filter(r=>['collected_tigerair','collected_starlux'].includes(r.kind)).length,
  airlineCodes:[...discovered].sort(),queries:checked,airportDepartureChanges:changes};
await writeFile(path.join(root,'api-verification.json'),JSON.stringify(result,null,2),{flag:'wx'});
await writeFile(path.join(root,'api-progress.json'),JSON.stringify({state:'passed',datesComplete:checked.length}));
console.log(JSON.stringify({...result,queries:undefined},null,2));
