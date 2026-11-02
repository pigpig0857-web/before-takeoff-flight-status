import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const base='data/source-samples/crawler/ci-tpe-20261021';
const dir=base+'/destination-inventory-20261027';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const report=read(dir+'/audit.json');
assert.equal(sha(base+'/consolidated-candidates.json'),report.baselineSha256);
const records=read(dir+'/brunei-candidates.json').records;
const routes=read(dir+'/route-comparison.json');
const sections=read(dir+'/official-tpe-sections.json');
assert.equal(routes.length,58);
assert.equal(routes.filter(r=>r.carriers.includes('CI')).length,53);
const ids=new Set();
for(const r of records){
 const id=[r.date,r.number,r.origin,r.destination].join('|');
 assert(!ids.has(id));ids.add(id);
 assert(r.date>='2026-10-21'&&r.date<='2026-12-31');
 assert(r.date>=r.sourceValidFrom&&r.date<=r.sourceValidUntil);
 assert.equal(r.marketingCarrier,'CI');assert.equal(r.operatingCarrier,'BI');
 const wd=new Date(r.date+'T12:00:00Z').getUTCDay();
 assert([0,2,4].includes(wd));
 const out=r.origin==='TPE';
 assert.equal(r.number,out?'CI9504':'CI9503');
 assert.equal(r.operatingNumber,out?'BI452':'BI451');
 assert.equal(r.departure.slice(11,16),out?(wd===0?'13:10':'14:15'):(wd===0?'08:35':'09:40'));
 assert.equal(r.arrival.slice(11,16),out?(wd===0?'16:45':'17:50'):(wd===0?'12:10':'13:15'));
 assert.equal((Date.parse(r.arrival)-Date.parse(r.departure))/60000,215);
 assert.equal(sha(r.evidence.file),r.evidence.sha256);
 assert.equal(r.integratedIntoWebsite,false);
}
assert.equal(records.length,62);
assert.equal(records.filter(r=>r.origin==='TPE').length,31);
for(const route of routes){
 for(const direction of ['outbound','return']){
  assert(sections.some(s=>s.airport===route.airport&&s.direction===direction&&s.flightNumbers.length));
 }
}
const result={passed:true,checkedAt:new Date().toISOString(),routesChecked:58,ciRoutesChecked:53,
 newCIIdentities:62,duplicateIdentities:0,baselineUnchanged:true,websiteImportPerformed:false};
fs.writeFileSync(dir+'/independent-audit.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
