import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root='data/source-samples/crawler/khh-expansion-20261020';
const read=async(p)=>JSON.parse(await fs.readFile(p,'utf8'));
const sha=(b)=>createHash('sha256').update(b).digest('hex');
const id=(r)=>[r.date,r.airlineCode,r.number,r.departureAirport,r.arrivalAirport].join('|');
const brAudit=await read(root+'/eva/verified/independent-audit.json'),vnAudit=await read(root+'/vietnam/verified/audit.json');
assert.equal(brAudit.status,'passed');assert.equal(brAudit.routesComplete,14);assert.equal(brAudit.unresolvedSourceRows,0);assert.equal(brAudit.pendingTimeRecords,0);
assert.equal(vnAudit.status,'passed');assert.equal(vnAudit.queriesCompleted,292);assert.equal(vnAudit.sourceState,'downloaded');assert.equal(vnAudit.conflicts,0);
const records=[];
for(const [folder,audit] of [['eva',brAudit],['vietnam',vnAudit]]){
 const file=root+'/'+folder+'/verified/candidate-flights.json',body=await fs.readFile(file);assert.equal(sha(body),audit.candidateSha256);records.push(...JSON.parse(body).records);
}
const identities=new Set(records.map(id));assert.equal(identities.size,records.length);
const sourceCache=new Map();
const clock=(instant,zone)=>{
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant)).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
for(const r of records){
 assert.ok(r.departureAirport==='KHH'||r.arrivalAirport==='KHH');assert.notEqual(r.departureAirport,r.arrivalAirport);
 assert.ok(r.date>='2026-10-20'&&r.date<='2026-12-31');assert.equal(r.date,r.departure.slice(0,10));
 assert.equal(clock(r.departure,r.departureTimeZone),r.departure.slice(0,16));assert.equal(clock(r.arrival,r.arrivalTimeZone),r.arrival.slice(0,16));
 assert.equal((Date.parse(r.arrival)-Date.parse(r.departure))/60000,r.minutes);
 if(r.airlineCode==='VN'){
  const file=r.evidence.file;if(!sourceCache.has(file)){
   const bytes=await fs.readFile(file);assert.equal(sha(bytes),r.sourceSha256);sourceCache.set(file,JSON.parse(bytes));
  }
  const source=sourceCache.get(file).data.departureFlight.scheduleItems[r.evidence.itemIndex];assert.equal(source.connectedFlights.length,1);
  const segment=source.connectedFlights[0],f=segment.flightInfo;assert.equal(segment.numberOfStops,0);assert.equal(f.operatingAirlineCode,'VN');assert.equal(f.marketingAirlineCode,'VN');
  assert.equal('VN'+Number(f.marketingFlightNumber),r.number);assert.equal(f.departureLocation.locationCode,r.departureAirport);assert.equal(f.arrivalLocation.locationCode,r.arrivalAirport);
  assert.equal(f.departureLocation.dateTime.slice(0,16),r.departure.slice(0,16));assert.equal(f.arrivalLocation.dateTime.slice(0,16),r.arrival.slice(0,16));assert.equal(f.duration/60,r.minutes);
 }
}
const baseline=await read(root+'/website-before.json');for(const [file,hash] of Object.entries(baseline))assert.equal(sha(await fs.readFile('src/server/data/'+file)),hash);
const allWebsiteKeys=new Set();
for(const file of Object.keys(baseline))for(const r of (await read('src/server/data/'+file)).records||[]){
 const dep=r.departureAirport||r.origin||'TPE',arr=r.arrivalAirport||r.airport;
 allWebsiteKeys.add([r.date,r.airlineCode||r.number?.match(/^[A-Z0-9]{2}/)?.[0],r.number,dep,arr].join('|'));
}
assert.ok(records.every(r=>!allWebsiteKeys.has(id(r))),'Already imported identity');
const destinations=[...new Set(records.filter(r=>r.departureAirport==='KHH').map(r=>r.arrivalAirport))].sort();
for(const code of ['BR','VN'])for(const station of new Set(records.filter(r=>r.airlineCode===code&&r.departureAirport==='KHH').map(r=>r.arrivalAirport))){
 assert.ok(records.some(r=>r.airlineCode===code&&r.departureAirport===station&&r.arrivalAirport==='KHH'));
}
const out=root+'/staging';await fs.mkdir(out,{recursive:true});
for(const direction of ['outbound','inbound'])for(const month of ['2026-10','2026-11','2026-12']){
 const selected=records.filter(r=>r.date.startsWith(month)&&(direction==='outbound'?r.departureAirport==='KHH':r.arrivalAirport==='KHH')).sort((a,b)=>id(a).localeCompare(id(b)));
 const body=JSON.stringify({records:selected,integratedIntoWebsite:false},null,2)+'\n',stem=`${out}/${direction}-${month}`;
 await fs.writeFile(stem+'.json',body);await fs.writeFile(stem+'.checkpoint.json',JSON.stringify({records:selected.length,sha256:sha(body)},null,2));
}
const byAirline={};for(const code of ['BR','VN'])byAirline[code]={outbound:records.filter(r=>r.airlineCode===code&&r.departureAirport==='KHH').length,inbound:records.filter(r=>r.airlineCode===code&&r.arrivalAirport==='KHH').length};
const result={state:'audited_ready_for_integration',from:'2026-10-20',through:'2026-12-31',records:records.length,byAirline,destinations,duplicateIdentities:0,alreadyImportedIdentities:0,
 websiteFilesUnchanged:Object.keys(baseline).length,websiteImported:false,sourceScope:'Published direct operating-carrier schedules; no connecting or codeshare itineraries',
 tests:{independentBrHtmlReplay:true,vietnamRawJsonReplay:true,allLocalTimesAndDurations:true,roundtripRoutePairs:true},
 candidates:[{airlineCode:'BR',stations:['FUK','HKG','ICN','KIX','MFM','NRT','PVG']},{airlineCode:'VN',stations:['HAN','SGN']}],completedAt:new Date().toISOString()};
await fs.writeFile(out+'/progress.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
