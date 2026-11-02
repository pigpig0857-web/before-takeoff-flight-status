// Independent Node/Intl audit of the Python-produced candidate data, no network.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root='data/source-samples/crawler/airline-completeness-20261016';
const read=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const all=(await read(`${root}/candidate-flights.json`)).records;
const audit=await read(`${root}/audit.json`);
const coverage=await read(`${root}/coverage.json`);
const collection=await read(`${root}/collection-progress.json`);
assert.equal(collection.state,'completed');
assert.equal(Object.keys(collection.completed).length,154);
assert.equal(collection.pending.length,0);
assert.equal(coverage.groups.length,77*7);
assert.equal(all.length,audit.records);
const identities=new Set(),sourceHashes=new Map();
const local=(iso,zone)=>{
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(iso)).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};
for(const r of all) {
  const id=`${r.origin}|${r.date}|${r.number}|${r.airport}`;
  assert.ok(!identities.has(id));identities.add(id);
  for(const field of ['origin','date','airline','airlineCode','number','airport','countryCode','destination','destinationEnglish','departure','arrival','arrivalTimeZone','sourceUrl','fetchedAt']) assert.ok(r[field],`${id}: ${field}`);
  assert.match(r.number,/^[A-Z0-9]{2}\d+$/);
  assert.equal(r.number.slice(0,2),r.airlineCode);
  assert.ok(r.date>='2026-10-16'&&r.date<='2026-12-31');
  assert.equal(local(r.departure,'Asia/Taipei'),r.departure.slice(0,16));
  assert.equal(local(r.arrival,r.arrivalTimeZone),r.arrival.slice(0,16));
  assert.equal((Date.parse(r.arrival)-Date.parse(r.departure))/60000,r.minutes);
  assert.ok(r.minutes>0&&r.minutes<1440);
  assert.equal(r.originTimeZone,'Asia/Taipei');
  assert.equal(r.countryCode,r.airport==='HKG'?'HK':'JP');
  assert.equal(r.arrivalTimeZone,r.airport==='HKG'?'Asia/Hong_Kong':'Asia/Tokyo');
  assert.equal(r.integratedIntoWebsite,false);
  assert.equal(r.scheduledOnly,true);
  assert.equal(r.operatingAirline,null);
  assert.equal(r.codeshare,null);
  sourceHashes.set(r.evidence.file,r.evidence.sha256);
}
for(const group of coverage.groups) {
  const selected=all.filter(r=>r.origin===group.origin&&r.airport===group.airport&&r.date===group.date&&r.airlineCode===group.airlineCode);
  assert.equal(selected.length,group.records);
  assert.deepEqual(selected.map(r=>r.number).sort(),group.numbers.toSorted());
}
for(const code of ['7G','HB','CI','AK','SL','VZ','BR']) {
  const rows=(await read(`${root}/airlines/${code}.json`)).records;
  assert.equal(rows.length,all.filter(r=>r.airlineCode===code).length);
}
let monthlyTotal=0;
for(const month of ['2026-10','2026-11','2026-12']) {
  const rows=(await read(`${root}/months/${month}.json`)).records;
  assert.ok(rows.every(r=>r.date.startsWith(month)));monthlyTotal+=rows.length;
}
assert.equal(monthlyTotal,all.length);
for(const [file,digest] of sourceHashes) assert.equal(sha(await fs.readFile(file)),digest,`Source changed: ${file}`);
const protectedHashes=await read(`${root}/protected-hashes.json`);
for(const [file,digest] of Object.entries(protectedHashes)) assert.equal(sha(await fs.readFile(file)),digest,`Protected data changed: ${file}`);
assert.equal(all.filter(r=>r.airlineCode==='7G').length,33);
assert.equal(all.filter(r=>r.airlineCode==='HB').length,123);
const overnight=all.find(r=>r.number==='HB705'&&r.date==='2026-10-16');
assert.equal(overnight.arrival,'2026-10-17T01:35:00+08:00');
assert.equal(overnight.minutes,120);
const yearend=all.find(r=>r.number==='7G800'&&r.date==='2026-12-31');
assert.equal(yearend.arrival,'2026-12-31T06:15:00+09:00');
assert.equal(yearend.minutes,135);
const result={state:'passed',records:all.length,airportDateQueries:154,airlineAirportDateGroups:coverage.groups.length,
  sourceFilesHashChecked:sourceHashes.size,protectedFilesUnchanged:Object.keys(protectedHashes).length,
  duplicateIdentities:0,missingCoreFields:0,timeZoneAndDurationErrors:0,snapshotsConsistent:true,
  arrivalRolloverChecked:true,sourceFilesAndProductionDataUnchanged:true,integratedIntoWebsite:false};
try {
  assert.deepEqual(await read(`${root}/independent-audit.json`),result,'Previous independent audit differs');
} catch(error) {
  if(error.code!=='ENOENT') throw error;
  await fs.writeFile(`${root}/independent-audit.json`,JSON.stringify(result,null,2),{flag:'wx'});
}
console.log(JSON.stringify(result,null,2));
