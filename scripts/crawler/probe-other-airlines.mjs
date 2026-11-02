/** Small public-source feasibility probe; no challenge bypass or website import. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const sources = process.argv.includes('--followup') ? [
  {id:'peach-winter',url:'https://www.flypeach.com/application/files/6117/8943/9522/20260916_W26_20261025-20270327_int_EN.pdf',extension:'pdf'},
  {id:'starlux-result',url:'https://www.starlux-airlines.com/zh-TW/timetable/search-result?depAirport=TPE&arrAirport=NRT&date=2026-11-26',extension:'html'},
] : [
  {id:'ci', url:'https://cms-externalcontent-prod.s3.ap-northeast-1.amazonaws.com/ci/Prepare%20for%20the%20fly/CI-timetable.pdf',extension:'pdf'},
  {id:'tigerair',url:'https://www.tigerairtw.com/zh-TW/print/flight-schedule-table?slug=flight-schedule',extension:'html'},
  {id:'starlux',url:'https://www.starlux-airlines.com/zh-TW/timetable',extension:'html'},
  {id:'peach',url:'https://www.flypeach.com/en',extension:'html'},
  {id:'scoot',url:'https://booking.flyscoot.com/flight-schedule',extension:'html'},
];
const root=path.resolve('data/source-samples/crawler',`other-airlines-${Date.now()}`);
await fs.mkdir(root,{recursive:true});
const results=await Promise.allSettled(sources.map(async source=>{
  const startedAt=new Date().toISOString();
  try {
    const response=await fetch(source.url,{redirect:'manual',headers:{'User-Agent':'FlightStatusResearch/0.1 (public schedule feasibility test)','Accept':source.extension==='pdf'?'application/pdf':'text/html'},signal:AbortSignal.timeout(30000)});
    const record={...source,startedAt,status:response.status,contentType:response.headers.get('content-type')};
    if(response.status!==200){await response.body?.cancel();return {...record,result:'stopped_non_200'};}
    const reader=response.body.getReader(),chunks=[]; let bytes=0;
    try {while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>10000000)throw Error('Response size limit');chunks.push(part.value);}} finally{await reader.cancel().catch(()=>{});}
    const body=Buffer.concat(chunks),file=`${source.id}.${source.extension}`;
    await fs.writeFile(path.join(root,file),body);
    return {...record,result:'downloaded_not_yet_validated',bytes,sha256:createHash('sha256').update(body).digest('hex'),file};
  } catch(e){return {...source,startedAt,result:'failed',error:e.message};}
}));
const report={checkedAt:new Date().toISOString(),root,integratedIntoWebsite:false,results:results.map(r=>r.status==='fulfilled'?r.value:{result:'failed',error:String(r.reason)})};
await fs.writeFile(path.join(root,'http-report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
