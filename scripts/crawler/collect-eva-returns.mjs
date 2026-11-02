import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {labelDate} from './eva-table-scope.mjs';
import assert from 'node:assert/strict';
const args=process.argv.slice(2), opt=(n)=>args[args.indexOf(n)+1];
const python=opt('--python'), max=Number(args.includes('--max-tables')?opt('--max-tables'):1000);
const wanted=args.includes('--airport')?opt('--airport'):null;
const queryFrom=args.includes('--query-from')?opt('--query-from'):null;
if(queryFrom)assert.ok(wanted&&/^2026-\d{2}-\d{2}$/.test(queryFrom));
const khh=args.includes('--khh');
const root=khh?'data/source-samples/crawler/khh-expansion-20261020/eva':'data/source-samples/crawler/return-gaps-20261020/eva-returns';
const source='https://booking.evaair.com/flyeva/eva/b2c/flight-schedules.aspx?lang=en-hk';
const read=async(p)=>JSON.parse(await fs.readFile(p,'utf8'));
await fs.mkdir(root,{recursive:true});
try { const done=await read(root+'/completion.json'); if(done.state==='completed_direct_source_scope'){console.log('Saved collection complete; no repeated requests');process.exit(0);} } catch(e) {if(e.code!=='ENOENT')throw e;}
const save=async(n,v)=>{await fs.writeFile(`${root}/${n}.tmp`,JSON.stringify(v,null,2));await fs.rename(`${root}/${n}.tmp`,`${root}/${n}`);};
const parse=(file,mode='--parse-file')=>JSON.parse(execFileSync(python,['scripts/crawler/fetch-eva-form.py',mode,file],{encoding:'utf8',maxBuffer:8000000}));
let progress;
try{progress=await read(root+'/progress.json');}catch(e){if(e.code!=='ENOENT')throw e;
 const inventory=await read('data/source-samples/crawler/return-world-20261019/staging/progress.json');
 const catalog=parse('data/source-samples/crawler/eva-coverage-trial/airports.xml','--parse-airports-file').airports;
 const routes=khh?(await read('data/source-samples/crawler/khh-airline-research-20261016/airport-airline-inventory.json')).airlines.find(a=>a.code==='BR').destinations.flatMap(a=>[{airlineCode:'BR',origin:'KHH',destination:a},{airlineCode:'BR',origin:a,destination:'KHH'}]):inventory.uncollectedAirlineRoutes.filter(r=>r.airlineCode==='BR');
 progress={from:'2026-10-20',through:'2026-12-31',state:'collecting',integratedIntoWebsite:false,routes:routes.map(r=>({...r,value:catalog.find(a=>a.value.slice(-3)===(r.origin==='KHH'?r.destination:r.origin))?.value,observations:[],records:[],pending:[]}))};
 await save('progress.json',progress);
}
if(progress.state==='source_stopped')throw Error('Saved source stop; no retry');
const cookies=new Map();let last=0,tables=0; const deadline=Date.now()+14*60000;
async function request(url,file,fields){
 const u=new URL(url);assert.equal(u.origin,'https://booking.evaair.com');assert.equal(u.pathname.toLowerCase(),'/flyeva/eva/b2c/flight-schedules.aspx');
 await delay(Math.max(0,1500-(Date.now()-last)));last=Date.now();
 await fs.writeFile(`${root}/${file}.started.json`,JSON.stringify({url,query:fields?{origin:fields['ctl00$content$hid_Dep'],destination:fields['ctl00$content$hid_Arr'],date:fields['ctl00$content$txt_tbGoYYYYMM']}:null}),{flag:'wx'});
 const response=await fetch(url,{method:fields?'POST':'GET',headers:{Accept:'text/html',...(cookies.size?{Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')}:{}),...(fields?{Referer:source}:{})},body:fields?new URLSearchParams(fields):undefined,redirect:'manual',signal:AbortSignal.timeout(25000)});
 for(const c of response.headers.getSetCookie()){const p=c.split(';')[0],i=p.indexOf('=');if(i>0)cookies.set(p.slice(0,i),p.slice(i+1));}
 const body=Buffer.from(await response.arrayBuffer());assert.ok(body.length<2000000);
 await fs.writeFile(`${root}/${file}`,body,{flag:'wx'});
 const receipt={url,status:response.status,sha256:createHash('sha256').update(body).digest('hex'),fetchedAt:new Date().toISOString()};await save(file+'.receipt.json',receipt);
 if(response.status!==200||/captcha|access denied|verify you are human/i.test(body.toString()))throw Error(`Source refused ${response.status}; no retry`);
 return receipt;
}
try{
 for(const route of progress.routes){
  if(wanted&&route.origin!==wanted)continue;
  if(!route.value){route.status='airport_value_pending';continue;}
  const all=[];for(let d=Date.parse(queryFrom||progress.from);d<=Date.parse(progress.through);d+=86400000)all.push(new Date(d).toISOString().slice(0,10));
  if(queryFrom)route.queryFrom=queryFrom;
  const covered=new Set(route.observations.flatMap(o=>o.dates));
  if(all.every(d=>covered.has(d)))continue;
  if(tables>=max||Date.now()>=deadline)break;
  const form=`${route.origin}-${route.destination}-form-${Date.now()}.html`;await request(source,form);let page=parse(`${root}/${form}`);
  while(tables<max&&Date.now()<deadline){
   const remaining=all.filter(d=>!covered.has(d));if(!remaining.length)break;
   const query=remaining[Math.min(3,remaining.length-1)], file=`${route.origin}-${route.destination}-${query}-${Date.now()}.html`;
   const depValue=route.origin==='KHH'?'KHHKHH':route.value;
   const arrValue=route.origin==='KHH'?route.value:route.destination+route.destination;
   const changes={'ctl00$__MasterEVENTTARGET':'ctl00$content$btn_ok','ctl00$__MasterEVENTARGUMENT':'','ctl00$content$rbn_Segment1':'ONE_WAY','ctl00$content$hid_Dep':depValue,'ctl00$content$hid_Arr':arrValue,'ctl00$content$txt_formcity':depValue,'ctl00$content$txt_tocity':arrValue,'ctl00$content$txt_tbGoYYYYMM':query,'ctl00$content$txt_tbGo2YYYYMM':query};
   assert.ok(page.action&&Object.keys(changes).every(k=>Object.hasOwn(page.fields,k)));
   const receipt=await request(new URL(page.action,source).href,file,{...page.fields,...changes});tables++;page=parse(`${root}/${file}`);
   if(!page.rows.length){route.pending.push({query,file,reason:'No published table; not proof of no flights'});route.status='source_table_unavailable';await save('progress.json',progress);break;}
   const dates=page.rows[0].cells.map(c=>labelDate(c.dateLabel));assert.equal(dates.length,7);
   const scope=dates.filter(d=>all.includes(d));assert.ok(scope.some(d=>!covered.has(d)));
   for(const row of page.rows){
    assert.deepEqual(row.cells.map(c=>labelDate(c.dateLabel)),dates);
    const match=/^((?:BR|B7)\d+)([A-Z]{3})(\d{2}:\d{2})([A-Z]{3})(\d{2}:\d{2})([+-]\d+)?$/.exec(row.header);
    if(!match||match[2]!==route.origin||match[4]!==route.destination){route.pending.push({file,header:row.header,reason:'Unreviewed or multi-segment row'});continue;}
    for(const cell of row.cells){if(!cell.detailLink)continue;const date=labelDate(cell.dateLabel);if(!scope.includes(date))continue;
     const image=new URL(cell.carrierImage,source),link=new URL(cell.detailLink,source);
     assert.equal(link.origin,new URL(source).origin);assert.equal(link.pathname.toLowerCase(),'/flyeva/eva/b2c/flight-details.aspx');
     assert.equal(link.searchParams.get('Week_DT'),`${date.slice(5,7)}/${date.slice(8)}/${date.slice(0,4)}`);
     if(!image.pathname.endsWith('/BR.png')||!match[1].startsWith('BR'))continue;
     const record={date,number:match[1].replace(/^BR0+(?=\d)/,'BR'),origin:route.origin,destination:route.destination,departureTime:match[3],arrivalTime:match[5],arrivalDayOffset:Number(match[6]||0),file,detailLink:link.href,...receipt};
     const existing=route.records.find(r=>r.date===date&&r.number===record.number);
     if(existing)assert.deepEqual([existing.departureTime,existing.arrivalTime,existing.arrivalDayOffset],[record.departureTime,record.arrivalTime,record.arrivalDayOffset]);else route.records.push(record);
    }
   }
   route.observations.push({query,file,dates:scope,sha256:receipt.sha256});scope.forEach(d=>covered.add(d));
   route.status=all.every(d=>covered.has(d))?(queryFrom?'tables_saved_requested_subscope':'tables_saved'):'collecting';
   await save('progress.json',progress);console.log(JSON.stringify({route:`${route.origin}-${route.destination}`,days:covered.size,records:route.records.length,pending:route.pending.length}));
  }
 }
 progress.state=progress.routes.every(r=>r.status==='tables_saved')?'tables_saved':'batch_saved';
}catch(error){progress.state='source_stopped';progress.error=error.message;console.log(error.message);}
progress.updatedAt=new Date().toISOString();await save('progress.json',progress);
console.log(JSON.stringify({state:progress.state,tables,records:progress.routes.reduce((n,r)=>n+r.records.length,0)}));
