import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { arrivalAirport } from '../../src/features/flights/destinations';
import { normalizeCollected, type SavedFlight } from '../../src/server/providers/collected';
const base='data/source-samples/crawler/ci-tpe-20261021';
const log='data/flight-updates/ci-tpe-20261027';
const read=async(p:string)=>JSON.parse((await fs.readFile(p,'utf8')).replace(/^\uFEFF/,''));
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function main(){
 const groups=(await read(base+'/consolidated-candidates.json')).groups;
 const extension=(await read(base+'/recheck-20261027/confirmed-ci-extension.json')).records;
 const brunei=(await read(base+'/destination-inventory-20261027/brunei-candidates.json')).records;
 const rows=new Map<string,any>();
 const key=(r:any)=>[r.date,r.number,r.origin,r.destination].join('|');
 for(const g of groups){
  const clocks=new Set(g.observations.map((r:any)=>r.departure+'|'+r.arrival));
  assert.equal(clocks.size,1,'Unresolved baseline clocks '+g.identity);
  const ranked=[...g.observations].sort((a,b)=>Number(b.url.includes('china-airlines.com'))-Number(a.url.includes('china-airlines.com'))||Date.parse(b.fetchedAt)-Date.parse(a.fetchedAt));
  rows.set(g.identity,ranked[0]);
 }
 for(const r of [...extension,...brunei]){
  assert.equal(r.requiresReview,false);
  const old=rows.get(key(r));
  if(old)assert.equal(old.departure+'|'+old.arrival,r.departure+'|'+r.arrival);
  else rows.set(key(r),r);
 }
 assert.equal(rows.size,10202);
 const outbound:SavedFlight[]=[], inbound:any[]=[];
 const winterReceipt=await read(base+'/recheck-20261027/timetable-version.receipt.json');
 const summerReceipt=await read(base+'/winter/downloads/ci-timetable.receipt.json');
 const evidenceChecked=new Set<string>();
 for(const r of rows.values()){
  assert(r.date>='2026-10-21'&&r.date<='2026-12-31');
  assert.equal((Date.parse(r.arrival)-Date.parse(r.departure))/60000,r.minutes);
  const proof=r.evidence;
  if(!evidenceChecked.has(proof.file)){assert.equal(hash(await fs.readFile(proof.file)),proof.sha256);evidenceChecked.add(proof.file);}
  const source=r.confirmation||r;
  const url=source.url||source.receipt?.url||r.url;
  const pdfReceipt=proof.file.replaceAll('\\','/').endsWith('/recheck-20261027/CI-timetable.pdf')?winterReceipt:summerReceipt;
  const fetchedAt=source.fetchedAt||source.receipt?.capturedAt||r.fetchedAt||pdfReceipt.checkedAt||pdfReceipt.fetchedAt;
  assert(Number.isFinite(Date.parse(fetchedAt)),'Missing source capture time');
  if(r.origin==='TPE'){
   const airport=arrivalAirport(r.destination);assert(airport,'Unknown airport '+r.destination);
   const record:SavedFlight={origin:'TPE',number:r.number,airline:'中華航空',date:r.date,
    departure:r.departure,arrival:r.arrival,arrivalTimeZone:r.arrivalTimeZone,airport:r.destination,candidateAirport:null,
    destination:airport.city,destinationEnglish:airport.name,countryCode:airport.countryCode,
    terminal:r.terminal||null,arrivalTerminal:r.arrivalTerminal||null,aircraft:r.aircraft||null,minutes:r.minutes,
    kind:'collected_ci',label:r.sourceLabel||'華航官方預定班表',url,fetchedAt,
    operatingAirline:r.operatingAirline||null,operatingNumber:r.operatingNumber||null,codeshare:r.codeshare??null,page:proof.page||null,
    evidence:{file:proof.file,sha256:proof.sha256,sourceUrl:url},sourceNotice:'預定班表，非即時動態；共用班號依來源保留承運關係。'};
   normalizeCollected(record);outbound.push(record);
  }else{
   assert.equal(r.destination,'TPE');
   inbound.push({date:r.date,number:r.number,airlineCode:'CI',airline:'中華航空',departureAirport:r.origin,arrivalAirport:'TPE',
    departure:r.departure,arrival:r.arrival,departureTimeZone:r.departureTimeZone,arrivalTimeZone:r.arrivalTimeZone,
    arrivalDayOffset:Math.round((Date.parse(r.arrival.slice(0,10))-Date.parse(r.date))/86400000),minutes:r.minutes,
    url,fetchedAt,sourceSha256:proof.sha256,sourceNotice:'預定班表，非即時動態。',
    operatingAirline:r.operatingAirline||null,operatingNumber:r.operatingNumber||null,codeshare:r.codeshare??null,evidence:proof});
  }
 }
 const existing=(await read('src/server/data/return-flights.json')).records;
 const returnKey=(r:any)=>[r.date,r.number,r.departureAirport,r.arrivalAirport].join('|');
 const old=new Map(existing.map((r:any)=>[returnKey(r),r]));
 const conflicts:any[]=[];
 const returns=inbound.filter(r=>{const e:any=old.get(returnKey(r));if(!e)return true;
  if(e.departure!==r.departure||e.arrival!==r.arrival)conflicts.push({identity:returnKey(r),existing:e,incoming:r,decision:'preserve_existing_exclude_incoming'});
  return false;});
 const now=new Date().toISOString();
 const snapshot={version:1,importedAt:now,records:outbound,coverage:[{kind:'collected_ci',label:'華航桃園已收集來回班表',
  url:'https://booking.china-airlines.com/Flightschedule/',fetchedAt:outbound.map(r=>r.fetchedAt).sort().at(-1),description:'2026/10/21～12/31 已核對候選；來源差異保留，衝突班次未匯入。',
  dates:[...new Set(outbound.map(r=>r.date))].sort(),records:outbound.length}]};
 await fs.mkdir(log,{recursive:true});
 const protectedFiles=(await fs.readdir('src/server/data')).filter(n=>n.endsWith('.json')&&!n.startsWith('ci-tpe-'));
 const before=Object.fromEntries(await Promise.all(protectedFiles.map(async n=>[n,hash(await fs.readFile('src/server/data/'+n))])));
 const report={importedAt:now,acceptedResearchIdentities:rows.size,outbound:outbound.length,inboundCandidates:inbound.length,
  addedReturnIdentities:returns.length,existingReturnIdentitiesPreserved:inbound.length-returns.length,
  incomingReturnConflictsExcluded:conflicts.length,knownWuhanConflictsExcluded:18,evidenceFilesChecked:evidenceChecked.size,before};
 for(const [name,value] of [['ci-tpe-flights.json',snapshot],['ci-tpe-returns.json',{from:'2026-10-21',through:'2026-12-31',records:returns}] ] as const){
  const target='src/server/data/'+name;
  try{await fs.copyFile(target,log+'/'+name+'.before.json',fs.constants.COPYFILE_EXCL);}catch(e:any){if(!['ENOENT','EEXIST'].includes(e.code))throw e;}
  await fs.writeFile(target,JSON.stringify(value)+'\n');
 }
 await fs.writeFile(log+'/conflicts.json',JSON.stringify(conflicts,null,2)+'\n');
 for(const [n,h] of Object.entries(before))assert.equal(hash(await fs.readFile('src/server/data/'+n)),h,n);
 await fs.writeFile(log+'/report.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({...report,before:undefined}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
