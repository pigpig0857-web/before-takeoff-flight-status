// Collect only six explicitly advertised public timetable route/date groups.
// Save every response; resume successes and stop rather than retry a failed source.
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

const root='data/source-samples/crawler/destination-expansion-20261016';
const endpoint='https://www.kansai-airport.or.jp/tw/flight/schedule?ajax_form=1';
const read=async f=>JSON.parse((await fs.readFile(f,'utf8')).replace(/^\uFEFF/,''));
const hash=b=>createHash('sha256').update(b).digest('hex');
const targets=[];
for(const to of ['NRT','ICN','HKG']) for(const from of ['TPE','KHH']) {
  for(let d=new Date('2026-10-16T00:00:00Z'); d<=new Date('2026-12-31T00:00:00Z');d.setUTCDate(d.getUTCDate()+1)) {
    const date=d.toISOString().slice(0,10);targets.push({from,to,date,id:`${from}-${to}-${date}`});
  }
}
const validate=(bytes,q)=>{
  const commands=JSON.parse(bytes.toString('utf8'));
  const html=commands.find(c=>c.command==='insert'&&c.selector==='#flight-results-wrapper')?.data;
  if(!html?.includes('flight-card-schedule')) throw new Error('No confirmed timetable cards; pending, never infer no flights');
  const dates=[...new Set([...html.matchAll(/outboundDate=(\d{4}-\d{2}-\d{2})/g)].map(m=>m[1]))];
  if(dates.length!==1||dates[0]!==q.date) throw new Error('Response date not confirmed');
  if(!html.includes(`(${q.from})`)||!html.includes(`(${q.to})`)) throw new Error('Response route not confirmed');
  if(/captcha|access denied|verify you are human/i.test(html)) throw new Error('Source challenge; stop');
  return commands.find(c=>c.command==='update_build_id')?.new;
};
let progress;
try {progress=await read(`${root}/collection-progress.json`);}
catch(e) {
  if(e.code!=='ENOENT') throw e;
  const base=`${root}/kansai-tpe-nrt-2026-12-31`;
  const receipt=await read(`${base}.receipt.json`), bytes=await fs.readFile(`${base}.body`);
  if(receipt.status!==200||hash(bytes)!==receipt.sha256) throw new Error('Sample evidence invalid');
  const q={from:'TPE',to:'NRT',date:'2026-12-31'};
  progress={state:'collecting',scope:{origins:['TPE','KHH'],destinations:['NRT','ICN','HKG'],from:'2026-10-16',through:'2026-12-31'},expected:targets.length,completed:{'TPE-NRT-2026-12-31':{...q,file:`${base}.body`,sha256:receipt.sha256,fetchedAt:receipt.fetchedAt,reusedSample:true}},pending:[],nextBuildId:validate(bytes,q),integratedIntoWebsite:false};
}
const save=async()=>{
  progress.savedAt=new Date().toISOString();
  const file=`${root}/progress-${randomUUID()}.tmp`;
  await fs.writeFile(file,JSON.stringify(progress,null,2),{flag:'wx'});
  await fs.rename(file,`${root}/collection-progress.json`);
};
await save();
if(progress.pending.length||progress.state==='source_stopped') throw new Error('Saved pending source; no retry');
const started=Date.now();
for(const q of targets) {
  if(progress.completed[q.id]) continue;
  if(Date.now()-started>14*60_000){progress.state='batch_saved';await save();console.log(JSON.stringify({state:progress.state,completed:Object.keys(progress.completed).length}));process.exit(0);}
  const base=`${root}/kansai-${q.id.toLowerCase()}`;
  const request={url:endpoint,method:'POST',query:{from:q.from,to:q.to,date:q.date},startedAt:new Date().toISOString(),authenticated:false};
  // Exclusive creation also stops an interrupted request from being repeated.
  await fs.writeFile(`${base}.started.json`,JSON.stringify(request,null,2),{flag:'wx'});
  try {
    const body=new URLSearchParams({...request.query,form_id:'schedule_flight_search_form',form_build_id:progress.nextBuildId,op:'搜尋'});
    const response=await fetch(endpoint,{method:'POST',body,headers:{'content-type':'application/x-www-form-urlencoded'},redirect:'manual',signal:AbortSignal.timeout(25000)});
    let size=0;const chunks=[];
    for await(const c of response.body){size+=c.length;if(size>6_000_000)throw new Error('Bounded response size exceeded');chunks.push(c);}
    const bytes=Buffer.concat(chunks);
    await fs.writeFile(`${base}.body`,bytes,{flag:'wx'});
    const receipt={...request,status:response.status,fetchedAt:new Date().toISOString(),bytes:size,sha256:hash(bytes),sourceLabel:'Kansai Airports public timetable supplied by OAG'};
    await fs.writeFile(`${base}.receipt.json`,JSON.stringify(receipt,null,2),{flag:'wx'});
    if(response.status!==200)throw new Error(`HTTP ${response.status}; no retry`);
    progress.nextBuildId=validate(bytes,q)||progress.nextBuildId;
    progress.completed[q.id]={from:q.from,to:q.to,date:q.date,file:`${base}.body`,sha256:receipt.sha256,fetchedAt:receipt.fetchedAt};
    progress.state='collecting';await save();
    if(Object.keys(progress.completed).length%10===0)console.log(JSON.stringify({completed:Object.keys(progress.completed).length,expected:targets.length,last:q.id}));
  }catch(e){
    const pending={...q,error:e.message,host:'www.kansai-airport.or.jp',sourceStopped:true,at:new Date().toISOString()};
    await fs.writeFile(`${base}.pending.json`,JSON.stringify(pending,null,2),{flag:'wx'});
    progress.pending.push(pending);progress.state='source_stopped';await save();throw e;
  }
  await new Promise(r=>setTimeout(r,750));
}
progress.state='completed';await save();console.log(JSON.stringify({state:progress.state,completed:Object.keys(progress.completed).length,expected:targets.length}));
