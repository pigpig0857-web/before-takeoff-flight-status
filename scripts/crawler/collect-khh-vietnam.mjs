import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const root='data/source-samples/crawler/khh-expansion-20261020/vietnam';
await fs.mkdir(root,{recursive:true});
const read=async(p)=>JSON.parse(await fs.readFile(p,'utf8'));
const sha=(b)=>createHash('sha256').update(b).digest('hex');
const plan=[];
for(const station of ['HAN','SGN'])for(const [origin,destination] of [['KHH',station],[station,'KHH']])for(let ms=Date.parse('2026-10-20');ms<=Date.parse('2026-12-31');ms+=86400000){
 const date=new Date(ms).toISOString().slice(0,10);
 plan.push({id:`vn-${origin}-${destination}-${date}`,origin,destination,date,url:`https://integration-middleware-website.vietnamairlines.com/api/v1/public/flight/schedule-table?originLocationCode=${origin}&destinationLocationCode=${destination}&departureDate=${date}`});
}
await fs.writeFile(root+'/plan.json',JSON.stringify(plan,null,2));
let progress;try{progress=await read(root+'/progress.json');}catch(e){if(e.code!=='ENOENT')throw e;progress={state:'collecting',completed:[],integratedIntoWebsite:false};}
if(progress.state==='source_stopped')throw Error('Saved source stop; no repeat');
const deadline=Date.now()+14*60000;
const save=async()=>{await fs.writeFile(root+'/progress.json.tmp',JSON.stringify(progress,null,2));await fs.rename(root+'/progress.json.tmp',root+'/progress.json');};
for(const query of plan){
 if(progress.completed.includes(query.id))continue;
 if(Date.now()>=deadline){progress.state='batch_saved';break;}
 const stem=root+'/'+query.id;
 try{
  let body,receipt;
  const sample='data/source-samples/crawler/khh-expansion-20261020/probes/'+query.id;
  try{receipt=await read(sample+'.receipt.json');body=await fs.readFile(sample+'.body');if(receipt.status!==200||sha(body)!==receipt.sha256)throw Error('Saved sample invalid');}
  catch(e){if(e.code!=='ENOENT')throw e;
   try{await fs.access(stem+'.started.json');throw Error('Unfinished request; review before retry');}catch(check){if(check.code!=='ENOENT')throw check;}
   await fs.writeFile(stem+'.started.json',JSON.stringify(query),{flag:'wx'});
   const res=await fetch(query.url,{redirect:'manual',signal:AbortSignal.timeout(25000)});body=Buffer.from(await res.arrayBuffer());
   receipt={url:query.url,status:res.status,sha256:sha(body),fetchedAt:new Date().toISOString()};
  }
  await fs.writeFile(stem+'.body',body,{flag:'wx'});await fs.writeFile(stem+'.receipt.json',JSON.stringify(receipt,null,2),{flag:'wx'});
  if(receipt.status!==200)throw Error(`HTTP ${receipt.status}; no retry`);
  const payload=JSON.parse(body);if(payload.success!==true||!Array.isArray(payload.data?.departureFlight?.scheduleItems))throw Error('Incomplete schedule response');
  progress.completed.push(query.id);progress.state='collecting';progress.updatedAt=new Date().toISOString();await save();
  if(progress.completed.length%10===0)console.log(JSON.stringify({completed:progress.completed.length,total:plan.length}));
  await delay(500);
 }catch(error){progress.state='source_stopped';progress.failed=query;progress.reason=error.message;await save();console.log(JSON.stringify(progress));break;}
}
if(progress.completed.length===plan.length)progress.state='downloaded';await save();console.log(JSON.stringify({state:progress.state,completed:progress.completed.length,total:plan.length}));
