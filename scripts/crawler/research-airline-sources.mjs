// Bounded, resumable research only. Never imports candidates into the website.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [planFile] = process.argv.slice(2);
const plan = JSON.parse(await fs.readFile(planFile, 'utf8'));
const root = path.resolve(plan.root);
const date = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Taipei'}).format(new Date());
if (date > '2026-12-31') throw Error('Scope expired');
if (!root.startsWith(path.resolve('data/source-samples/crawler') + path.sep)) throw Error('Research root outside workspace');
if (!Array.isArray(plan.requests) || plan.requests.length > 12) throw Error('Small reviewed batch required');
await fs.mkdir(root, {recursive:true});
const read = async file => JSON.parse(await fs.readFile(file,'utf8'));
const existing = async file => fs.access(file).then(()=>true,()=>false);
const stopFile = path.join(root, 'source-stops.json');
const stops = await existing(stopFile) ? await read(stopFile) : {};
const dailyFile = path.resolve('data/automatic-verification/source-stops',date+'.json');
const dailyStops = await existing(dailyFile) ? await read(dailyFile) : {};
const results = [];
async function checkpoint() {
  const receipts = (await fs.readdir(root)).filter(file => file.endsWith('.receipt.json')).sort();
  const all = await Promise.all(receipts.map(file => read(path.join(root, file))));
  await fs.writeFile(path.join(root,'research-progress.json'),JSON.stringify({at:new Date().toISOString(),integratedIntoWebsite:false,results:all},null,2)+'\n');
}
for (const request of plan.requests) {
  const url = new URL(request.url);
  if (!/^[a-z0-9-]+$/.test(request.id) || url.protocol !== 'https:' || url.username || url.password || !plan.allowedHosts.includes(url.hostname)) throw Error('Unreviewed request');
  const stem = path.join(root,request.id);
  if (await existing(stem+'.receipt.json')) { results.push(await read(stem+'.receipt.json')); continue; }
  if (stops[url.hostname] || dailyStops[url.hostname]) { results.push({id:request.id,state:'skipped_stopped_source',host:url.hostname}); continue; }
  if (await existing(stem+'.started.json')) { results.push({id:request.id,state:'saved_interrupted_request_not_repeated'}); continue; }
  const startedAt = new Date().toISOString();
  await fs.writeFile(stem+'.started.json',JSON.stringify({...request,startedAt},null,2),{flag:'wx'});
  let result;
  try {
    const response = await fetch(url,{method:request.method || 'GET',redirect:'manual',signal:AbortSignal.timeout(25000),headers:{accept:'*/*',...request.headers},body:request.body});
    const chunks=[];let size=0;
    for await (const chunk of response.body || []) { size+=chunk.length; if(size>20_000_000) throw Error('Source size limit'); chunks.push(chunk); }
    const body=Buffer.concat(chunks);
    await fs.writeFile(stem+'.body',body,{flag:'wx'});
    const title=body.subarray(0,500000).toString().match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
    const challenge=/access denied|just a moment|security verification|robot challenge|akamai.*challenge|verify.*human/i.test(title) || /Request unsuccessful\.\s*Incapsula incident ID/i.test(body.subarray(0,500000).toString());
    result={id:request.id,url:url.href,method:request.method||'GET',startedAt,fetchedAt:new Date().toISOString(),status:response.status,location:response.headers.get('location'),contentType:response.headers.get('content-type'),bytes:size,sha256:createHash('sha256').update(body).digest('hex'),state:challenge?'stopped_challenge':response.status===200?'downloaded_not_yet_validated':response.status>=300&&response.status<400?'redirect_review_required':'stopped_http_error',authenticated:false};
    if(challenge || response.status>=400) stops[url.hostname]={at:result.fetchedAt,reason:result.state,status:response.status};
  } catch(e) {
    result={id:request.id,url:url.href,startedAt,at:new Date().toISOString(),state:'stopped_connection_error',reason:`${e.message}; ${e.cause?.code||''}`};
    stops[url.hostname]={at:result.at,reason:result.reason};
  }
  await fs.writeFile(stem+'.receipt.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  await fs.writeFile(stopFile,JSON.stringify(stops,null,2)+'\n');
  results.push(result);
  await checkpoint();
  console.log(JSON.stringify({id:result.id,status:result.status,state:result.state,bytes:result.bytes,reason:result.reason}));
}
await checkpoint();
