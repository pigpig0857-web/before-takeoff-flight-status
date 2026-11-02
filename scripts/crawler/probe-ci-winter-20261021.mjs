import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root='data/source-samples/crawler/ci-tpe-20261021/winter';
await fs.mkdir(root,{recursive:true});
const sources=[
 ['ci-schedule','https://booking.china-airlines.com/Flightschedule/?country=tw&locale=zh'],
 ['ci-information','https://www.china-airlines.com/tw/zh/fly/flight-status/index'],
 ['narita-ci','https://www.narita-airport.jp/en/flight/airline-search/cal/'],
];
for(const [id,url] of sources){
 const stem=`${root}/${id}`;
 try{await fs.access(stem+'.started.json');console.log(id+': saved attempt skipped');continue;}catch(e){if(e.code!=='ENOENT')throw e;}
 await fs.writeFile(stem+'.started.json',JSON.stringify({url,startedAt:new Date().toISOString()}),{flag:'wx'});
 let receipt={url,fetchedAt:new Date().toISOString()};
 try{
  const res=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(25000)});
  const bytes=Buffer.from(await res.arrayBuffer());
  await fs.writeFile(stem+'.body',bytes,{flag:'wx'});
  receipt={...receipt,status:res.status,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,
   location:res.headers.get('location'),state:res.status===200?'received_needs_validation':'stopped_http'};
 }catch(e){receipt={...receipt,state:'stopped_connection',error:e.message,cause:e.cause?.code};}
 await fs.writeFile(stem+'.receipt.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify({id,...receipt}));
}
