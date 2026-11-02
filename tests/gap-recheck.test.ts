import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import snapshot from '../src/server/data/return-flights.json';
import {findReturnFlights} from '../src/server/services/return-flights';
const root='data/source-samples/crawler/gap-recheck-20261020';
const read=async(file:string)=>JSON.parse(await fs.readFile(file,'utf8'));
test('December NU301 adds exactly 31 supported dates and preserves all existing rows and retrieval age',async()=>{
 const before=await read(root+'/return-before.json');
 assert.equal(before.records.length,13125);
 assert.deepEqual(snapshot.records.slice(0,13125),before.records);
 const rows=snapshot.records.filter(r=>r.number==='NU301'&&r.date.startsWith('2026-12'));
 assert.equal(rows.length,31);assert.equal(new Set(rows.map(r=>r.date)).size,31);
 for(const row of rows){
  assert.equal(row.departure,`${row.date}T08:30:00+09:00`);
  assert.equal(row.arrival,`${row.date}T09:15:00+08:00`);
  assert.equal(row.minutes,105);assert.equal(row.fetchedAt,'2026-10-14T03:23:04.881Z');
  assert.match(row.sourceNotice!,/尚待重新核對/);
  const results=findReturnFlights(new URLSearchParams({origin:'OKA',destination:'TPE',date:row.date,notBefore:'2026-11-30T18:30:00+09:00'}));
  assert.equal(results.flights.find(f=>f.number==='NU301')!.departure,row.departure);
 }
 assert.equal(snapshot.pendingCount,1);
 assert.ok(!snapshot.records.some(r=>r.number==='IT707'&&r.date==='2026-10-22'));
});
test('December clock correction is directly published in preserved official table and corroborated without origin retry',async()=>{
 const file='data/source-samples/crawler/new-airlines-20261014/jta-browser-schedule.json';
 const data=await read(file),table=data.tables[1].rows.find((r:string[])=>r[0]==='NU301');
 assert.equal(data.periods[1],'2026-10-25/2027-03-27');
 assert.match(table[2],/advanced by 5 minutes from December 1 to January 31/);
 assert.equal(table[3],'9:15');assert.equal(table[4],'Daily');
 const digest=createHash('sha256').update(await fs.readFile(file)).digest('hex');
 assert.equal(snapshot.records.find(r=>r.number==='NU301'&&r.date==='2026-12-31')!.sourceSha256,digest);
 const index=await read(root+'/jta-official-index-evidence.json');assert.equal(index.liveVerifiedAt,null);
});
test('416 published Tigerair rows match and the single duration conflict stays unresolved',async()=>{
 const audit=await read(root+'/tigerair-gap-audit.json');
 assert.equal(audit.matched,416);assert.deepEqual(audit.missing,[]);assert.deepEqual(audit.changed,[]);
 assert.deepEqual(audit.unexpectedSaved,[]);assert.deepEqual(audit.sourceConflicts,[]);
 assert.equal(audit.pending.length,1);assert.match(audit.pending[0].identity,/2026-10-22\|IT707\|NGO\|TPE/);
 assert.equal(audit.pending[0].sourceMinutes,1255);assert.equal(audit.pending[0].clockMinutes,185);
});
