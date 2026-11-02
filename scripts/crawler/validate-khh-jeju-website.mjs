import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root='data/flight-updates/khh-jeju-import-1792117923640';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const snapshots=await Promise.all(['kaohsiung','kaohsiung-peach','kaohsiung-jetstar','kaohsiung-jeju'].map(b=>read(`src/server/data/${b}-flights.json`)));
const rows=snapshots.flatMap(s=>s.records).filter(r=>r.date>='2026-10-16');
const jeju=snapshots[3].records;let calls=[];let total=0,newRows=0;
async function query(params){const res=await fetch('http://127.0.0.1:3000/api/flights?'+new URLSearchParams(params),{signal:AbortSignal.timeout(30000)});assert.equal(res.status,200);const d=await res.json();calls.push({params,total:d.total});return d;}
for(const date of [...new Set(rows.map(r=>r.date))].sort()){
 const data=await query({origin:'KHH',date}),expected=rows.filter(r=>r.date===date);
 assert.equal(data.total,expected.length);assert.equal(data.feeds.length,6);
 for(const f of data.flights){
  const r=expected.find(r=>r.number===f.number&&r.airport===f.destinationCode);assert.ok(r);assert.equal(f.origin,'KHH');assert.equal(f.scheduledDeparture,r.departure);assert.equal(f.scheduledArrival,r.arrival);assert.equal(f.durationMinutes,r.minutes);assert.equal(f.timetableVerification.state,'verified');total++;
  if(f.airlineCode==='7C'){assert.equal(f.terminal,null);assert.equal(f.aircraft,null);newRows++;}
 }
 const airline=await query({origin:'KHH',date,q:'濟州航空'});
 assert.equal(airline.total,jeju.filter(r=>r.date===date).length);assert.ok(airline.flights.every(f=>f.airlineCode==='7C'));
 if(calls.length%20===0)await fs.writeFile(root+'/api-progress.json',JSON.stringify({state:'checking',calls},null,2));
}
assert.equal(total,904);assert.equal(newRows,110);
for(const q of ['韓國','GMP','PUS']){
 const d=await query({origin:'KHH',date:'2026-12-31',q});assert.ok(d.total>0);
 if(q!=='韓國')assert.ok(d.flights.every(f=>f.destinationCode===q));
 assert.ok(d.flights.some(f=>f.airlineCode==='7C'));
}
const empty=await query({origin:'KHH',date:'2026-12-30',q:'GMP'});assert.ok(empty.flights.every(f=>f.airlineCode!=='7C'));
const late=await query({origin:'KHH',date:'2026-12-31',q:'濟州航空',start:'15:00'});assert.equal(late.total,1);assert.equal(late.flights[0].destinationCode,'PUS');
for(const date of ['2026-10-24','2026-10-25','2026-10-27']){const d=await query({origin:'KHH',date,q:'濟州航空'});assert.deepEqual(d.flights.map(f=>f.number).sort(),jeju.filter(r=>r.date===date).map(r=>r.number).sort());}
const tpe=await query({origin:'TPE',date:'2026-12-31',q:'濟州航空'});assert.ok(tpe.total>0);assert.ok(tpe.flights.every(f=>(f.origin||'TPE')==='TPE'));
const outside=await query({origin:'KHH',date:'2027-01-01'});assert.equal(outside.total,0);assert.equal(outside.resultState,'outside_coverage');
const old=await read(root+'/before-progress.json');for(const [file,hash]of Object.entries(old.originals))assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'),hash);
const before=await read(root+'/before-ledger.json'),ledger=await read('data/automatic-verification/latest.json');for(const[k,v]of Object.entries(before.entries))assert.deepEqual(ledger.entries[k],v);
const report={state:'passed',savedAt:new Date().toISOString(),dateQueries:77,records:total,jejuRecords:newRows,queries:calls.length,originalCatalogueFilesUnchanged:Object.keys(old.originals).length,oldLedgerEntriesUnchanged:Object.keys(before.entries).length,calls};
await fs.writeFile(root+'/api-progress.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,calls:undefined}));
