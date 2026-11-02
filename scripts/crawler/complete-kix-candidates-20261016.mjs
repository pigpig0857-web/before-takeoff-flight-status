// Complete only previously researched TPE/KHH -> KIX dates, using public forms.
// Current-day saved successes are reused; a pending request stops the source.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const root = 'data/source-samples/crawler/airline-completeness-20261016';
const research = 'data/source-samples/crawler/new-airlines-20261016';
const daily = 'data/automatic-verification/runs/2026-10-16';
const endpoint = 'https://www.kansai-airport.or.jp/tw/flight/schedule?ajax_form=1';
const read = async file => JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
await fs.mkdir(root,{recursive:true});
const days=[];
for(let d=new Date('2026-10-16T00:00:00Z');d<=new Date('2026-12-31T00:00:00Z');d.setUTCDate(d.getUTCDate()+1)) days.push(d.toISOString().slice(0,10));
const validate = (bytes,origin,day) => {
  const commands=JSON.parse(bytes.toString('utf8'));
  const result=commands.find(c=>c.command==='insert'&&c.selector==='#flight-results-wrapper');
  if(!result?.data?.includes('flight-card-schedule')) throw new Error('No confirmed timetable cards');
  const dates=[...new Set([...result.data.matchAll(/outboundDate=(\d{4}-\d{2}-\d{2})/g)].map(m=>m[1]))];
  if(dates.length!==1 || dates[0]!==day) throw new Error('Departure date not confirmed');
  if(!result.data.includes(`(${origin})`) || !result.data.includes('(KIX)')) throw new Error('Route not confirmed');
  return commands.find(c=>c.command==='update_build_id')?.new;
};
let progress;
try { progress=await read(`${root}/collection-progress.json`); }
catch(error) {
  if(error.code!=='ENOENT') throw error;
  progress={state:'collecting',from:days[0],through:days.at(-1),origins:['TPE','KHH'],destination:'KIX',expectedDateGroups:days.length*2,completed:{},pending:[],integratedIntoWebsite:false};
  const previous=await read(`${daily}/progress.json`);
  for(const [id,outcome] of Object.entries(previous.completed)) {
    if(outcome.kind!=='collected_kix'||outcome.state!=='compared') continue;
    const file=`${daily}/${id}.body`, receipt=await read(`${daily}/${id}.receipt.json`),bytes=await fs.readFile(file);
    if(receipt.status!==200||sha(bytes)!==receipt.sha256) throw new Error('Prior successful evidence changed');
    const commands=JSON.parse(bytes.toString('utf8'));
    const insert=commands.find(c=>c.selector==='#flight-results-wrapper');
    const dates=[...new Set([...insert.data.matchAll(/outboundDate=(\d{4}-\d{2}-\d{2})/g)].map(m=>m[1]))];
    if(dates.length!==1||!days.includes(dates[0])) throw new Error('Unexpected saved source date');
    validate(bytes,'TPE',dates[0]);
    progress.completed[`TPE-${dates[0]}`]={origin:'TPE',date:dates[0],file,sha256:receipt.sha256,fetchedAt:receipt.fetchedAt,state:'current_day_success_reused'};
  }
  for(const day of ['2026-10-17','2026-11-26','2026-12-31']) {
    const file=`${research}/kix-khh-${day}.body`,receipt=await read(`${research}/kix-khh-${day}.receipt.json`),bytes=await fs.readFile(file);
    if(receipt.status!==200||sha(bytes)!==receipt.sha256) throw new Error('Saved sample evidence changed');
    validate(bytes,'KHH',day);
    progress.completed[`KHH-${day}`]={origin:'KHH',date:day,file,sha256:receipt.sha256,fetchedAt:receipt.fetchedAt,state:'current_day_success_reused'};
  }
  const last=await fs.readFile(`${research}/kix-khh-2026-12-31.body`);
  progress.nextBuildId=validate(last,'KHH','2026-12-31');
  if(!progress.nextBuildId) throw new Error('Missing public form state');
}
const checkpoint = async () => {
  progress.savedAt=new Date().toISOString();
  const file=`${root}/progress-${randomUUID()}.tmp`;
  await fs.writeFile(file,JSON.stringify(progress,null,2),{flag:'wx'});
  await fs.rename(file,`${root}/collection-progress.json`);
};
await checkpoint();
if(progress.pending.length || progress.state==='source_stopped') throw new Error('Saved pending source requires review; no retry');
const jobStarted=Date.now();
for(const origin of ['KHH','TPE']) for(const day of days) {
  const id=`${origin}-${day}`;
  if(progress.completed[id]) continue;
  if(Date.now()-jobStarted>14*60_000) {progress.state='batch_saved';await checkpoint();console.log('batch_saved');process.exit(0);}
  for(const file of ['data/automatic-verification/source-stops/2026-10-16.json',`${research}/source-stops.json`]) {
    const stops=await read(file);
    if(stops['www.kansai-airport.or.jp']||stops.sources?.['www.kansai-airport.or.jp']) throw new Error('Airport source already stopped today');
  }
  const base=`${root}/kix-${id.toLowerCase()}`;
  const request={url:endpoint,method:'POST',query:{from:origin,to:'KIX',date:day},startedAt:new Date().toISOString(),authenticated:false};
  await fs.writeFile(`${base}.started.json`,JSON.stringify(request,null,2),{flag:'wx'});
  try {
    const body=new URLSearchParams({from:origin,to:'KIX',date:day,form_id:'schedule_flight_search_form',form_build_id:progress.nextBuildId,op:'搜尋'});
    const response=await fetch(endpoint,{method:'POST',body,headers:{'content-type':'application/x-www-form-urlencoded'},redirect:'manual',signal:AbortSignal.timeout(25000)});
    const chunks=[];let size=0;
    for await(const chunk of response.body) {size+=chunk.length;if(size>3_000_000) throw new Error('Response exceeds bounded source size');chunks.push(chunk);}
    const bytes=Buffer.concat(chunks);
    await fs.writeFile(`${base}.body`,bytes,{flag:'wx'});
    const receipt={...request,status:response.status,fetchedAt:new Date().toISOString(),bytes:size,sha256:sha(bytes),providerDisclosure:'Kansai Airports published schedule supplied by OAG'};
    await fs.writeFile(`${base}.receipt.json`,JSON.stringify(receipt,null,2),{flag:'wx'});
    if(response.status!==200) throw new Error(`HTTP ${response.status}; no retry`);
    progress.nextBuildId=validate(bytes,origin,day)||progress.nextBuildId;
    progress.completed[id]={origin,date:day,file:`${base}.body`,sha256:receipt.sha256,fetchedAt:receipt.fetchedAt,state:'saved_success'};
    progress.state='collecting';await checkpoint();
    if(Object.keys(progress.completed).length%10===0) console.log(JSON.stringify({completed:Object.keys(progress.completed).length,expected:progress.expectedDateGroups,last:id}));
  } catch(error) {
    const pending={id,origin,date:day,error:error.message,host:'www.kansai-airport.or.jp',sourceStopped:true};
    await fs.writeFile(`${base}.pending.json`,JSON.stringify(pending,null,2),{flag:'wx'});
    progress.pending.push(pending);progress.state='source_stopped';await checkpoint();throw error;
  }
  await new Promise(resolve=>setTimeout(resolve,750));
}
progress.state='completed';await checkpoint();
console.log(JSON.stringify({state:progress.state,completed:Object.keys(progress.completed).length,expected:progress.expectedDateGroups}));
