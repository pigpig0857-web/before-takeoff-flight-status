import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root='data/source-samples/crawler/return-gaps-20261020';
const read=async(file)=>JSON.parse(await fs.readFile(file,'utf8'));
const hash=(bytes)=>createHash('sha256').update(bytes).digest('hex');
const identity=(r)=>[r.date,r.airlineCode,r.number,r.departureAirport,r.arrivalAirport].join('|');
const rows=[];
for(const month of ['2026-10','2026-11','2026-12']){
 const bytes=await fs.readFile(`${root}/staging/flights-${month}.json`);
 const receipt=await read(`${root}/staging/checkpoint-${month}.json`);
 assert.equal(hash(bytes),receipt.sha256);
 const batch=JSON.parse(bytes).records;assert.equal(batch.length,receipt.records);rows.push(...batch);
}
assert.equal(rows.length,12305);
const map=new Map(rows.map(r=>[identity(r),r]));assert.equal(map.size,rows.length);
const original=await read('src/server/data/return-flights.json');assert.equal(original.records.length,6998);
const originalKeys=new Set(original.records.map(identity));
for(const r of original.records)assert.deepEqual(map.get(identity(r)),r);
const before=await read(root+'/website-before.json');
for(const [file,sha] of Object.entries(before))assert.equal(hash(await fs.readFile('src/server/data/'+file)),sha);
let checked=0;
for(const r of rows.filter(r=>!originalKeys.has(identity(r)))){
 const local=(instant,zone)=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
 for(const [field,zone] of [['departure',r.departureTimeZone],['arrival',r.arrivalTimeZone]]){
  const t=local(r[field],zone);assert.equal(`${t.year}-${t.month}-${t.day}T${t.hour}:${t.minute}`,r[field].slice(0,16));
 }
 assert.equal(r.date,r.departure.slice(0,10));assert.equal((Date.parse(r.arrival)-Date.parse(r.departure))/60000,r.minutes);
 assert.ok(r.minutes>=30&&r.minutes<=1500&&['TPE','KHH'].includes(r.arrivalAirport));checked++;
}
assert.equal(checked,5307);
const eva=await read(root+'/eva-returns/verified/independent-audit.json');
assert.equal(eva.routesComplete,47);assert.equal(eva.unresolvedSourceRows,0);assert.equal(eva.conflicts,0);
const result={state:'completed_direct_source_scope',newRecords:checked,totalStaged:rows.length,originalRecordsPreserved:6998,websiteFilesUnchanged:18,duplicateIdentities:0,
 javascriptTimezoneAndDurationChecked:checked,sourceAudit:root+'/eva-returns/verified/independent-audit.json',
 pending:['32 NU date-specific records','2026-10-22 IT707 duration mismatch'],websiteImported:false,completedAt:new Date().toISOString()};
await fs.writeFile(root+'/eva-returns/completion.json',JSON.stringify(result,null,2));
await fs.writeFile(root+'/completion.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
