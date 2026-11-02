import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root='data/source-samples/crawler/return-final-20261020';
const previous='data/source-samples/crawler/return-gaps-20261020';
const read=async(p)=>JSON.parse(await fs.readFile(p,'utf8'));
const sha=(b)=>createHash('sha256').update(b).digest('hex');
const id=(r)=>[r.date,r.airlineCode,r.number,r.departureAirport,r.arrivalAirport].join('|');
const records=[];
for(const month of ['2026-10','2026-11','2026-12']){
 const bytes=await fs.readFile(`${previous}/staging/flights-${month}.json`);
 assert.equal(sha(bytes),(await read(`${previous}/staging/checkpoint-${month}.json`)).sha256);
 records.push(...JSON.parse(bytes).records);
}
assert.equal(records.length,12305);
const receipt=await read(root+'/naha-depart.receipt.json');
const bytes=await fs.readFile(root+'/naha-depart.body');assert.equal(sha(bytes),receipt.sha256);assert.equal(receipt.status,200);
const datesReceipt=await read(root+'/naha-dates.receipt.json');
assert.equal(sha(await fs.readFile(root+'/naha-dates.body')),datesReceipt.sha256);
assert.deepEqual(await read(root+'/naha-dates.body'),{start_date:'2026年10月01日',end_date:'2026年10月31日'});
const row=JSON.parse(bytes).TPE.data.find(r=>r.carrierFsCode==='NU'&&r.flightNumber==='307');
assert.equal(row.departureAirportFsCode,'OKA');assert.equal(row.arrivalAirportFsCode,'TPE');
assert.match(row.en_remarks,/10\/9・11・12・24\s+Departure 18:05\s+Arrival 18:40/);
const old=(await read('data/source-samples/crawler/return-world-20261019/staging/jta-historical-pending.json')).records.find(r=>r.date==='2026-10-24'&&r.number==='NU307');
assert.equal(old.departure,'2026-10-24T18:05:00+09:00');assert.equal(old.arrival,'2026-10-24T18:40:00+08:00');
assert.equal((Date.parse(old.arrival)-Date.parse(old.departure))/60000,95);
records.push({...old,url:receipt.url,fetchedAt:receipt.fetchedAt,sourceSha256:receipt.sha256,
 evidence:{file:root+'/naha-depart.body',rowId:row.id,validityFile:root+'/naha-dates.body'},
 sourceNotice:'那霸機場官方月班表：10/24依日期註記為18:05出發、18:40抵達；預定班表非即時動態。'});
assert.equal(new Set(records.map(id)).size,12306);
const original=await read('src/server/data/return-flights.json');
assert.equal(original.records.length,6998);
const map=new Map(records.map(r=>[id(r),r]));for(const r of original.records)assert.deepEqual(map.get(id(r)),r);
const baseline=await read(previous+'/website-before.json');
for(const [file,hash] of Object.entries(baseline))assert.equal(sha(await fs.readFile('src/server/data/'+file)),hash);
const pending=(await read(previous+'/jta-company-verified/pending.json')).filter(r=>!(r.date==='2026-10-24'&&r.number==='NU307'));
assert.equal(pending.length,31);
pending.push({date:'2026-10-22',number:'IT707',reason:'Published duration 1255 contradicts clock-derived 185; alternate airport source HTTP403'});
await fs.mkdir(root+'/staging',{recursive:true});
for(const month of ['2026-10','2026-11','2026-12']){
 const selected=records.filter(r=>r.date.startsWith(month)).sort((a,b)=>id(a).localeCompare(id(b)));
 const body=JSON.stringify({records:selected,integratedIntoWebsite:false},null,2)+'\n';
 await fs.writeFile(`${root}/staging/flights-${month}.json`,body);
 await fs.writeFile(`${root}/staging/checkpoint-${month}.json`,JSON.stringify({records:selected.length,sha256:sha(body)},null,2));
}
await fs.writeFile(root+'/staging/pending.json',JSON.stringify(pending,null,2));
const summary={state:'ready_with_32_pending_requires_scope_decision',records:12306,newRecords:5308,preserved:6998,duplicates:0,pending:32,websiteImported:false,
 byArrivalAirport:{TPE:records.filter(r=>r.arrivalAirport==='TPE').length,KHH:records.filter(r=>r.arrivalAirport==='KHH').length},
 sourceEvidence:'naha-depart.body + date_range.json',reasonNotImported:'User requested complete collection before import; 32 date-specific records remain unresolved'};
await fs.writeFile(root+'/staging/progress.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
