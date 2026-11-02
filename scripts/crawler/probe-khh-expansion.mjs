import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='data/source-samples/crawler/khh-expansion-20261020/probes';
await fs.mkdir(root,{recursive:true});
const plans=[
 ['kia','https://www.kia.gov.tw/data/flightplan.json'],
 ['ci','https://booking.china-airlines.com/Flightschedule/'],
 ['tw','https://www.twayair.com/app/serviceInfo/flightSchedule'],
 ['bx','https://www.airbusan.com/web/individual/booking/easyScheduling'],
 ['tw-official-redirect','https://www.trinityairways.com/app/serviceInfo/flightSchedule'],
 ['tw-whole-schedule','https://www.trinityairways.com/app/serviceInfo/flightSchedule?showWholeSchedule=Y'],
];
for(const airport of ['HAN','SGN'])for(const [a,b] of [['KHH',airport],[airport,'KHH']])for(const date of ['2026-11-26','2026-12-31'])plans.push([`vn-${a}-${b}-${date}`,`https://integration-middleware-website.vietnamairlines.com/api/v1/public/flight/schedule-table?originLocationCode=${a}&destinationLocationCode=${b}&departureDate=${date}`]);
const stopped=new Set();
for(const [name,url] of plans){
 const stem=root+'/'+name,host=new URL(url).host;
 try{await fs.access(stem+'.started.json');const r=JSON.parse(await fs.readFile(stem+'.receipt.json','utf8'));if(r.state==='source_stopped')stopped.add(host);continue;}catch(e){if(e.code!=='ENOENT')throw e;}
 if(stopped.has(host))continue;
 await fs.writeFile(stem+'.started.json',JSON.stringify({url,startedAt:new Date().toISOString()}),{flag:'wx'});
 let receipt={url,fetchedAt:new Date().toISOString()};
 try{
  const res=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(25000)});
  const body=Buffer.from(await res.arrayBuffer());await fs.writeFile(stem+'.body',body,{flag:'wx'});
  receipt={...receipt,status:res.status,sha256:createHash('sha256').update(body).digest('hex'),state:res.status===200&&!/captcha|access denied|verify you are human/i.test(body.toString())?'saved':'source_stopped'};
 }catch(error){receipt={...receipt,state:'source_stopped',reason:error.message};}
 if(receipt.state==='source_stopped')stopped.add(host);
 await fs.writeFile(stem+'.receipt.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify({name,...receipt}));
}
