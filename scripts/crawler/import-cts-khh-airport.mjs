import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root='data/source-samples/crawler/cts-khh-20261020';
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex');
const bytes=await fs.readFile(root+'/airport-schedule.body');
const receipt=await read(root+'/airport-schedule.receipt.json');
assert.equal(receipt.status,200); assert.equal(sha(bytes),receipt.sha256);
const raw=JSON.parse(bytes), candidates=[];
for(const [rowIndex,row] of raw.items.entries()){
 if(row.DA!=='D'||row.DepartureAreaCode!=='CTS'||row.ArrivalAreaCode!=='DMK')continue;
 const operator=row.Airline.find(a=>a.Airline_2Cd==='SL'&&a.Flight==='SL393'&&a.SharingfltDiv===0);
 if(!operator)continue;
 assert.equal(row.Transits.length,1);
 const stop=row.Transits[0];assert.equal(stop.AreaCode,'KHH');assert.equal(stop.NextDayArrival,false);
 for(const date of row.ActiveDate.filter(d=>d>='2026-10-20'&&d<='2026-10-31')){
  const departure=`${date}T${row.DepartureTime}:00+09:00`,arrival=`${date}T${stop.ArrivalTime}:00+08:00`;
  const minutes=(Date.parse(arrival)-Date.parse(departure))/60000;
  assert.ok(minutes>0&&minutes<600);
  candidates.push({date,number:'SL393',airlineCode:'SL',airline:'泰獅航空',departureAirport:'CTS',arrivalAirport:'KHH',
   departure,arrival,departureTimeZone:'Asia/Tokyo',arrivalTimeZone:'Asia/Taipei',arrivalDayOffset:0,minutes,
   url:'https://www.hokkaido-airports.com/zh-CHT/new-chitose/airport/time/',fetchedAt:receipt.fetchedAt,
   sourceSha256:receipt.sha256,evidence:{file:root+'/airport-schedule.body',rowIndex,segment:'CTS-KHH'},
   status:'published_schedule',sourceNotice:'新千歲機場官方班表：僅顯示札幌至高雄航段，同班號後續飛曼谷；班表不代表可售機位，請向航空公司確認。'});
 }
}
assert.deepEqual(candidates.map(r=>r.date).sort(),['2026-10-21','2026-10-23','2026-10-26','2026-10-28','2026-10-30']);
const file='src/server/data/return-flights.json',old=await fs.readFile(file),snapshot=JSON.parse(old);
const key=r=>[r.date,r.number,r.departureAirport,r.arrivalAirport].join('|');
const existing=new Set(snapshot.records.map(key));
const added=candidates.filter(r=>!existing.has(key(r)));
if(!added.length){console.log('Already imported; no changes');process.exit(0);}
assert.equal(added.length,5);assert.equal(snapshot.records.length,13098);
await fs.writeFile(root+'/return-before.json',old,{flag:'wx'});
await fs.writeFile(root+'/candidates.json',JSON.stringify({records:candidates},null,2));
snapshot.records.push(...added);
assert.equal(new Set(snapshot.records.map(key)).size,snapshot.records.length);
snapshot.version=5;
await fs.writeFile(file+'.cts.tmp',JSON.stringify(snapshot,null,2)+'\n',{flag:'wx'});
await fs.rename(file+'.cts.tmp',file);
await fs.writeFile(root+'/import.json',JSON.stringify({state:'imported',added:5,total:snapshot.records.length,scopeThrough:'2026-10-31',originalPreserved:13098,sha256:sha(await fs.readFile(file))},null,2));
console.log('Imported 5 explicitly dated SL393 CTS-KHH segments; original 13098 preserved.');
