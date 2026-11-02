// Separate published campaign pages, not a retry of the blocked timetable service.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='data/source-samples/crawler/ci-tpe-20261021/published-oceania';
await fs.mkdir(root,{recursive:true});
const sources=[
 ['announcement.html','https://2026oce.china-airlines.com/'],
 ['summer-announcement.html','https://2026ste.china-airlines.com/'],
 ...[1,2,3,4].map(n=>[`timetable0${n}.png`,`https://2026oce.china-airlines.com/images/s01/timetable0${n}.png`]),
];
for(const [name,url] of sources){
 const file=`${root}/${name}`;
 try{await fs.access(file+'.started.json');console.log(name+': existing attempt retained');continue;}catch(e){if(e.code!=='ENOENT')throw e;}
 await fs.writeFile(file+'.started.json',JSON.stringify({url,startedAt:new Date().toISOString()}),{flag:'wx'});
 let receipt={url,file,fetchedAt:new Date().toISOString()};
 try{
  const res=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(25000)});
  const bytes=Buffer.from(await res.arrayBuffer());
  await fs.writeFile(file,bytes,{flag:'wx'});
  const refused=res.status!==200||/access denied|verify you are human|<title>just a moment/i.test(bytes.toString('utf8'));
  receipt={...receipt,status:res.status,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,state:refused?'source_stopped':'received_needs_validation'};
 }catch(e){receipt={...receipt,state:'source_stopped',error:e.message};}
 await fs.writeFile(file+'.receipt.json',JSON.stringify(receipt,null,2));
 console.log(JSON.stringify(receipt));
 if(receipt.state==='source_stopped'){process.exitCode=1;break;}
 await new Promise(resolve=>setTimeout(resolve,800));
}
