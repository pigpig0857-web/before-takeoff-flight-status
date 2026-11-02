import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='data/source-samples/crawler/return-final-20261020';
await fs.mkdir(root,{recursive:true});
for(const [name,url] of [
 ['centrair','https://www.centrair.jp/flight/schedule/international-departure-01.html?period=0'],
 ['naha','https://www.naha-airport.co.jp/en/flight/month/'],
 ['naha-month-js','https://www.naha-airport.co.jp/common/js/flight_month.js?ver=4.9.8'],
 ['naha-month-run-js','https://www.naha-airport.co.jp/common/js/flight_month_run.js?ver=4.9.8'],
 ['naha-depart','https://www.naha-airport.co.jp/common/json/depart_flight_schedule.json'],
 ['naha-dates','https://www.naha-airport.co.jp/common/json/date_range.json'],
]){
 const stem=root+'/'+name;
 try{await fs.access(stem+'.started.json');continue;}catch(e){if(e.code!=='ENOENT')throw e;}
 await fs.writeFile(stem+'.started.json',JSON.stringify({url,at:new Date().toISOString()}),{flag:'wx'});
 let receipt={url,fetchedAt:new Date().toISOString()};
 try{
  const res=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(25000)});
  const body=Buffer.from(await res.arrayBuffer());await fs.writeFile(stem+'.body',body,{flag:'wx'});
  receipt={...receipt,status:res.status,sha256:createHash('sha256').update(body).digest('hex'),state:res.status===200?'saved':'source_stopped'};
 }catch(error){receipt={...receipt,state:'source_stopped',reason:error.message};}
 await fs.writeFile(stem+'.receipt.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify({name,...receipt}));
}
