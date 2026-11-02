// Public airport form only. Reuse evidence, save every query, stop on source refusal.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='data/source-samples/crawler/ci-tpe-20261021/network';
const base='https://www.kansai-airport.or.jp/tw/flight/schedule';
const read=async p=>JSON.parse((await fs.readFile(p,'utf8')).replace(/^\uFEFF/,''));
const sha=b=>createHash('sha256').update(b).digest('hex');
await fs.mkdir(root,{recursive:true});
const old=(await read('data/cache/ci-network/flights.json')).records;
let additionalAirports=[];
try{additionalAirports=(await read('data/source-samples/crawler/ci-tpe-20261021/network-discovery/additional-airports.json')).airports;}
catch(e){if(e.code!=='ENOENT')throw e;}
const airports=[...new Set([...old.filter(r=>!r.operatingCarrier||r.operatingCarrier==='CI').map(r=>r.arrivalAirport||r.candidateArrivalAirport).filter(Boolean),'TOY','CTU','TFU',...additionalAirports])];
const days=Array.from({length:72},(_,i)=>new Date(Date.UTC(2026,9,21+i)).toISOString().slice(0,10));
const targets=[];
// Finish both directions of each destination before moving to the next route.
for(const airport of airports)for(const day of days)for(const [from,to] of [['TPE',airport],[airport,'TPE']])targets.push({id:`${from}-${to}-${day}`,from,to,date:day});
let job;
try{job=await read(root+'/progress.json');}catch(e){if(e.code!=='ENOENT')throw e;}
if(!job){
 job={state:'collecting',airports,from:'2026-10-21',through:'2026-12-31',expected:targets.length,completed:{},pending:[],build:null,integratedIntoWebsite:false};
 const existing=[
  'data/source-samples/crawler/destination-expansion-20261016/collection-progress.json',
  'data/source-samples/crawler/airline-completeness-20261016/collection-progress.json',
 ];
 for(const path of existing){
  const p=await read(path);
  for(const r of Object.values(p.completed)){
   const from=r.from||r.origin,to=r.to||'KIX',date=r.date;
   if(!targets.some(q=>q.id===`${from}-${to}-${date}`))continue;
   const bytes=await fs.readFile(r.file);if(sha(bytes)!==r.sha256)throw Error('Reuse hash mismatch');
   job.completed[`${from}-${to}-${date}`]={...r,from,to,date,reused:true};
  }
 }
 const p=await read('data/source-samples/crawler/return-world-20261019/kix/progress.json');
 for(const day of p.completed.filter(d=>days.includes(d))){
  const file=`data/source-samples/crawler/return-world-20261019/kix/${day}.body`;
  const r=await read(file.replace('.body','.receipt.json'));
  if(sha(await fs.readFile(file))!==r.sha256)throw Error('Return reuse hash mismatch');
  job.completed[`KIX-TPE-${day}`]={...r,from:'KIX',to:'TPE',date:day,file,reused:true};
 }
}
const save=async()=>{job.savedAt=new Date().toISOString();await fs.writeFile(root+'/progress.json',JSON.stringify(job,null,2));};
if(job.state==='source_stopped')throw Error('Source stopped; no retry');
async function pauseRequested(){
 try{return (await read(root+'/pause-request.json')).active===true;}catch(e){if(e.code==='ENOENT')return false;throw e;}
}
if(await pauseRequested()){
 job.state='paused_by_user';job.pausedAt=new Date().toISOString();job.collectionProcessId=null;
 await save();console.log(JSON.stringify({state:job.state,completed:Object.keys(job.completed).length,pending:job.pending.length}));process.exit(0);
}
if(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei'}).format(new Date())>'2026-12-31')throw Error('Collection window ended; no more requests');
job.state='collecting';job.collectionProcessId=process.pid;
job.airports=airports;job.expected=targets.length;
job.inventoryNote='Historical route candidates plus published Toyama, two Chengdu airport discovery queries and visually reviewed official map additions. Queries do not assert a TPE nonstop service exists; whole-network completeness is unconfirmed.';
job.satisfiedByOfficial ||= {};
const targetIds=new Set(targets.map(q=>q.id));
async function refreshOfficialCoverage(){try {
 const official=await read('data/source-samples/crawler/ci-tpe-20261021/official-browser/covered-date-groups.json');
 for(const id of official)if(targetIds.has(id)&&!job.completed[id]&&!job.pending.some(p=>p.id===id))job.satisfiedByOfficial[id]={source:'official-browser/covered-date-groups.json'};
}catch(e){if(e.code!=='ENOENT')throw e;}}
await refreshOfficialCoverage();
await save();
async function collect(id,query){
 const stem=root+'/'+id;
 try{await fs.access(stem+'.started.json');throw Error('Unfinished query already saved: '+id);}catch(e){if(e.code!=='ENOENT')throw e;}
 await fs.writeFile(stem+'.started.json',JSON.stringify({query,startedAt:new Date().toISOString()}),{flag:'wx'});
 const url=base+(query?'?ajax_form=1':'');
 const response=await fetch(url,{method:query?'POST':'GET',body:query?new URLSearchParams({...query,form_id:'schedule_flight_search_form',form_build_id:job.build,op:'搜尋'}):undefined,redirect:'manual',signal:AbortSignal.timeout(25000)});
 const bytes=Buffer.from(await response.arrayBuffer());
 await fs.writeFile(stem+'.body',bytes,{flag:'wx'});
 const receipt={url,status:response.status,query,fetchedAt:new Date().toISOString(),sha256:sha(bytes),file:stem+'.body'};
 await fs.writeFile(stem+'.receipt.json',JSON.stringify(receipt,null,2),{flag:'wx'});
 if(response.status!==200||/access denied|verify you are human|<title>just a moment/i.test(bytes.toString()))throw Error('Source refused HTTP '+response.status);
 if(bytes.length>6000000)throw Error('Source size bound');
 return {bytes,receipt};
}
try{
 if(!job.build){const {bytes}=await collect('index',null);job.build=bytes.toString().match(/<input[^>]+name="form_build_id"[^>]*value="([^"]+)"/)?.[1];if(!job.build)throw Error('No public form token');await save();}
 const started=Date.now();let requests=0,lastAirport=null;
 for(const q of targets){
  if(await pauseRequested()){job.state='paused_by_user';job.pausedAt=new Date().toISOString();job.collectionProcessId=null;await save();break;}
  const airport=q.from==='TPE'?q.to:q.from;
  if(airport!==lastAirport){await refreshOfficialCoverage();lastAirport=airport;}
  if(job.completed[q.id]||job.satisfiedByOfficial[q.id]||job.pending.some(p=>p.id===q.id))continue;
  if(requests>=1000||Date.now()-started>14*60000){job.state='batch_saved';await save();break;}
  const {bytes,receipt}=await collect(q.id,{from:q.from,to:q.to,date:q.date});requests++;
  const commands=JSON.parse(bytes.toString());job.build=commands.find(c=>c.command==='update_build_id')?.new||job.build;
  const html=commands.find(c=>c.selector==='#flight-results-wrapper')?.data||'';
  const dates=[...new Set([...html.matchAll(/outboundDate=(\d{4}-\d{2}-\d{2})/g)].map(m=>m[1]))];
  if(!html.includes('flight-card-schedule')||dates.length!==1||dates[0]!==q.date||!html.includes(`(${q.from})`)||!html.includes(`(${q.to})`)){
   job.pending.push({...q,...receipt,reason:'No complete dated direct-card evidence; not proof of no flights'});
  }else job.completed[q.id]={...q,...receipt};
  await save();
  if(requests%10===0)console.log(JSON.stringify({requests,completed:Object.keys(job.completed).length,pending:job.pending.length,expected:job.expected,current:q.id}));
  await new Promise(r=>setTimeout(r,650));
 }
 if(Object.keys(job.completed).length+job.pending.length+Object.keys(job.satisfiedByOfficial).length===job.expected)job.state=job.pending.length?'completed_with_pending':'downloaded';
 await save();console.log(JSON.stringify({state:job.state,completed:Object.keys(job.completed).length,pending:job.pending.length,expected:job.expected}));
}catch(e){job.state='source_stopped';job.error=e.message;await save();console.log(JSON.stringify({state:job.state,error:e.message,completed:Object.keys(job.completed).length}));process.exitCode=1;}
