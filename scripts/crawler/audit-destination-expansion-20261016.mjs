// Independent offline audit of saved candidate identities, timing and source cards.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const root='data/source-samples/crawler/destination-expansion-20261016';
const prior='data/source-samples/crawler/airline-completeness-20261016';
const read=async f=>JSON.parse((await fs.readFile(f,'utf8')).replace(/^\uFEFF/,''));
const sha=b=>createHash('sha256').update(b).digest('hex');
const canonical=s=>{const m=/^([A-Z0-9]{2})0*(\d+)([A-Z]?)$/.exec(s.replace(/\s/g,'').toUpperCase());if(!m)throw Error(`Bad number ${s}`);return m[1]+BigInt(m[2]).toString()+m[3];};
const identity=r=>[r.origin??'TPE',r.date,canonical(r.number),r.airport].join('|');
const eq=(a,b)=>['departure','arrival'].every(k=>Date.parse(a[k])===Date.parse(b[k]));
const assert=(ok,msg)=>{if(!ok)throw Error(msg);};
const progress=await read(`${root}/collection-progress.json`);
assert(progress.state==='completed'&&Object.keys(progress.completed).length===462&&!progress.pending.length,'Collection incomplete');
const protectedFiles=await read(`${root}/protected-hashes.json`);
for(const [f,h] of Object.entries(protectedFiles))assert(sha(await fs.readFile(f))===h,`Protected file changed: ${f}`);
const base=new Map();
for(const f of [...(await fs.readdir('src/server/data')).filter(x=>x.endsWith('flights.json')).map(x=>`src/server/data/${x}`),`${prior}/candidate-flights.json`]){
  const obj=await read(f);
  for(const r of obj.records??obj){if(r.date<'2026-10-16'||r.date>'2026-12-31'||!r.airport||!r.number)continue;
    const k=identity(r);if(!base.has(k))base.set(k,[]);base.get(k).push(r);
  }
}
const newRows=(await read(`${root}/candidate-flights.json`)).records;
const sameRows=(await read(`${root}/existing-matches.json`)).records;
const different=(await read(`${root}/time-differences.json`)).records;
const conflicts=(await read(`${root}/source-conflicts.json`)).records;
assert(!conflicts.length,'Source conflicts require review');
const seen=new Set();
for(const r of newRows){const k=identity(r);assert(!seen.has(k),`Duplicate candidate ${k}`);seen.add(k);assert(!base.has(k),`Candidate overlaps baseline ${k}`);}
for(const item of sameRows){const r=item.currentEvidence,k=identity(r);assert(base.has(k),`Unmatched saved identity ${k}`);assert(base.get(k).every(x=>eq(x,r)),`Time mismatch in unchanged match ${k}`);}
for(const item of different){const r=item.currentEvidence,k=identity(r);assert(base.has(k),`New identity misclassified ${k}`);assert(base.get(k).some(x=>!eq(x,r)),`Unnecessary time difference ${k}`);}
assert(newRows.length+sameRows.length+different.length===new Set([...seen,...sameRows.map(x=>identity(x.currentEvidence)),...different.map(x=>identity(x.currentEvidence))]).size,'Identity partition overlap');
const rows=[...newRows,...sameRows.map(x=>x.currentEvidence),...different.map(x=>x.currentEvidence)];
const byFile=new Map();
for(const r of rows){const ev=r.evidence;assert(ev.file&&ev.sha256&&Number.isInteger(ev.cardIndex),'Missing evidence');if(!byFile.has(ev.file))byFile.set(ev.file,[]);byFile.get(ev.file).push(r);
  assert(r.date>=progress.scope.from&&r.date<=progress.scope.through,'Date outside scope');
  assert(['TPE','KHH'].includes(r.origin)&&['NRT','ICN','HKG'].includes(r.airport),'Route outside scope');
  assert(Number.isFinite(Date.parse(r.departure))&&Number.isFinite(Date.parse(r.arrival)),'Invalid time');
  assert((Date.parse(r.arrival)-Date.parse(r.departure))/60000===r.minutes,'Timezone/duration mismatch');
}
let sourceCardsChecked=0;
for(const [file,group] of byFile){
  const bytes=await fs.readFile(file),receipt=await read(file.replace(/\.body$/,'.receipt.json'));
  assert(receipt.status===200&&sha(bytes)===receipt.sha256,`Source hash/response invalid ${file}`);
  const commands=JSON.parse(bytes.toString('utf8'));
  const html=commands.find(x=>x.selector==='#flight-results-wrapper')?.data;
  assert(typeof html==='string',`Missing timetable HTML ${file}`);
  const tags=[...html.matchAll(/<div\s+data-flight-type="([^"]+)"\s+data-flight-departure="([^"]+)"\s+data-flight-airline="([^"]+)"[^>]*class="flight-card flight-card-schedule"[^>]*>/g)];
  for(const r of group){
    assert(r.evidence.sha256===receipt.sha256,`Evidence hash mismatch ${file}`);
    const tag=tags[r.evidence.cardIndex];assert(tag&&tag[1]==='direct',`Wrong direct card index ${file}`);
    assert(tag[2]===r.departure.slice(11,16)&&tag[3]===r.airlineCode,`Departure/airline mismatch ${file}`);
    const part=html.slice(tag.index,tags[r.evidence.cardIndex+1]?.index??html.length);
    const route=part.match(/class="flight-card-port-name"[^>]*>([\s\S]*?)<\/h3>/)?.[1]??'';
    assert([...route.matchAll(/\(([A-Z]{3})\)/g)].map(m=>m[1]).join('|')===`${r.origin}|${r.airport}`,`Route mismatch ${file}`);
    const primary=part.match(/class="flight-card-port-code"[^>]*>[\s\S]*?<strong>([A-Z0-9]+)<\/strong>/)?.[1];
    assert(primary===r.number,`Primary flight number mismatch ${file}`);
    const arrival=part.match(/class="flight-card-time-arr"[^>]*>([\s\S]*?)<\/div>/)?.[1]?.match(/\d{2}:\d{2}/)?.[0];
    assert(arrival===r.arrival.slice(11,16),`Arrival mismatch ${file}`);
    sourceCardsChecked++;
  }
}
const result={state:'passed',scope:progress.scope,completedDateGroups:Object.keys(progress.completed).length,sourceFilesChecked:byFile.size,
  sourceCardsChecked,newUniqueCandidates:newRows.length,alreadyPresentSameTimes:sameRows.length,timeDifferencesHeld:different.length,
  duplicateCandidates:0,overlapWithExisting:0,protectedFilesUnchanged:Object.keys(protectedFiles).length,integratedIntoWebsite:false};
await fs.writeFile(`${root}/independent-audit.json`,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
