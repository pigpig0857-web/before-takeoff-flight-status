// Ordinary public airport form only. Persist every result; never repeat a denial.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='data/source-samples/crawler/khh-more-airlines-20261020';
const base='https://www.kansai-airport.or.jp/tw/flight/schedule';
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex');
await fs.mkdir(root,{recursive:true});
const save=async j=>fs.writeFile(root+'/progress.json',JSON.stringify(j,null,2)+'\n');
const destinations=['KIX','NRT','ICN','HKG','BKK','MNL','KUL'];
const targets=[];
for(const day of ['2026-12-31',...Array.from({length:73},(_,i)=>new Date(Date.parse('2026-10-20')+i*86400000).toISOString().slice(0,10)).filter(d=>d!=='2026-12-31')])
 for(const airport of destinations)for(const [from,to] of [['KHH',airport],[airport,'KHH']])targets.push({from,to,date:day,id:`${from}-${to}-${day}`});
let job;
try{job=await read(root+'/progress.json');}catch(e){if(e.code!=='ENOENT')throw e;}
if(job?.state==='source_stopped')throw Error('Saved source refusal, not retried');
if(!job){
 job={state:'collecting',scope:{from:'2026-10-20',through:'2026-12-31',destinations,bothDirections:true},expected:targets.length,completed:{},pending:[],build:null};
 const old=await read('data/source-samples/crawler/destination-expansion-20261016/collection-progress.json');
 for(const q of targets){const found=old.completed[q.id];if(found){const b=await fs.readFile(found.file);if(sha(b)!==found.sha256)throw Error('Saved proof changed');job.completed[q.id]={...found,reused:true};}}
 await fs.writeFile(root+'/plan.json',JSON.stringify({targets},null,2),{flag:'wx'});
 await save(job);
}
// Reuse previous successful public responses, keeping their actual fetch dates.
const previousKix=await read('data/source-samples/crawler/airline-completeness-20261016/collection-progress.json');
let reusable=[];
for(const item of Object.values(previousKix.completed))if(item.origin==='KHH')reusable.push({...item,from:'KHH',to:'KIX'});
try{reusable.push(...Object.entries(await read(root+'/reuse-inventory.json')).flatMap(([route,items])=>items.map(item=>({...item,from:route.split('-')[0],to:route.split('-')[1]}))));}
catch(error){if(error.code!=='ENOENT')throw error;}
for(const item of reusable){
 const id=`${item.from}-${item.to}-${item.date}`;
 if(job.completed[id]||job.pending.some(p=>p.id===id)||!targets.some(t=>t.id===id))continue;
 const receipt=await read(item.file.replace(/\.body$/,'.receipt.json'));
 const bytes=await fs.readFile(item.file);
 if(receipt.status!==200||sha(bytes)!==item.sha256||receipt.sha256!==item.sha256)throw Error('Reusable source integrity mismatch');
 const commands=JSON.parse(bytes.toString());const html=commands.find(c=>c.selector==='#flight-results-wrapper')?.data||'';
 const dates=[...new Set([...html.matchAll(/outboundDate=(\d{4}-\d{2}-\d{2})/g)].map(m=>m[1]))];
 if(!html.includes('flight-card-schedule')||dates.length!==1||dates[0]!==item.date||!html.includes(`(${item.from})`)||!html.includes(`(${item.to})`))continue;
 job.completed[id]={id,from:item.from,to:item.to,date:item.date,file:item.file,sha256:item.sha256,fetchedAt:receipt.fetchedAt,status:200,url:receipt.url,reused:true};
}
await save(job);
if(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei'}).format(new Date())>'2026-12-31')throw Error('Outside project collection date range');
const stopped=JSON.parse(await fs.readFile('data/automatic-verification/source-stops/2026-10-20.json','utf8'));
if(stopped['www.kansai-airport.or.jp'])throw Error('Daily source stop; no request');
job.state='collecting';job.batchStartedAt=new Date().toISOString();await save(job);
const collect=async(url,id,query)=>{
 const stem=root+'/'+id;
 await fs.writeFile(stem+'.started.json',JSON.stringify({url,query,startedAt:new Date().toISOString()}),{flag:'wx'});
 const response=await fetch(url,{method:query?'POST':'GET',body:query?new URLSearchParams({...query,form_build_id:job.build,form_id:'schedule_flight_search_form',op:'搜尋'}):undefined,redirect:'manual',signal:AbortSignal.timeout(25000)});
 const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>6000000)throw Error('Source size bound');
 await fs.writeFile(stem+'.body',bytes,{flag:'wx'});
 const receipt={url,status:response.status,query,fetchedAt:new Date().toISOString(),sha256:sha(bytes),file:stem+'.body'};
 await fs.writeFile(stem+'.receipt.json',JSON.stringify(receipt,null,2),{flag:'wx'});
 if(response.status!==200||/access denied|verify you are human|<title>just a moment/i.test(bytes.toString()))throw Error('Source refused '+response.status);
 return {bytes,receipt};
};
try{
 if(!job.build){
  const {bytes}=await collect(base,'index',null);
  job.build=bytes.toString().match(/<input[^>]+name="form_build_id"[^>]*value="([^"]+)"/)?.[1];
  if(!job.build)throw Error('No ordinary form token');await save(job);
 }
 const start=Date.now();
 for(const q of targets){
  if(job.completed[q.id]||job.pending.some(p=>p.id===q.id))continue;
  if(Date.now()-start>14*60_000){job.state='batch_saved';await save(job);process.exit(0);}
  const {bytes,receipt}=await collect(base+'?ajax_form=1',q.id,{from:q.from,to:q.to,date:q.date});
  const commands=JSON.parse(bytes.toString());
  job.build=commands.find(c=>c.command==='update_build_id')?.new||job.build;
  const html=commands.find(c=>c.selector==='#flight-results-wrapper')?.data;
  const dates=[...new Set([...(html||'').matchAll(/outboundDate=(\d{4}-\d{2}-\d{2})/g)].map(m=>m[1]))];
  if(!html?.includes('flight-card-schedule')||dates.length!==1||dates[0]!==q.date||!html.includes(`(${q.from})`)||!html.includes(`(${q.to})`)){
   job.pending.push({...q,...receipt,reason:'No complete dated direct-card evidence; do not infer no flights'});
  }else job.completed[q.id]={...q,...receipt};
  await save(job);
  const done=Object.keys(job.completed).length+job.pending.length;
  if(done%20===0)console.log(JSON.stringify({done,expected:job.expected,reused:Object.values(job.completed).filter(x=>x.reused).length,pending:job.pending.length}));
  await new Promise(r=>setTimeout(r,650));
 }
 job.state=job.pending.length?'completed_with_pending':'downloaded';await save(job);console.log(JSON.stringify({state:job.state,completed:Object.keys(job.completed).length,pending:job.pending.length}));
}catch(error){job.state='source_stopped';job.error=error.message;await save(job);console.log(JSON.stringify({state:job.state,error:job.error,completed:Object.keys(job.completed).length}));process.exitCode=1;}
