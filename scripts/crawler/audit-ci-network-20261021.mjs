import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root='data/source-samples/crawler/ci-tpe-20261021';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const progress=read(root+'/network/progress.json');
const parsed=read(root+'/network/audit.json');
const officialStop=fs.existsSync(root+'/official-browser/source-state.json')?read(root+'/official-browser/source-state.json'):
 (fs.existsSync(root+'/official-browser/source-stop.json')?read(root+'/official-browser/source-stop.json'):null);
const frequencyClaims=fs.existsSync(root+'/published-oceania/frequency-observations.json')?read(root+'/published-oceania/frequency-observations.json'):null;
const groups=new Map();let observations=0,hashes=0;
const clockFormatters=new Map();
function zonedMinute(value,zone){
 if(!clockFormatters.has(zone))clockFormatters.set(zone,new Intl.DateTimeFormat('en-CA',{
  timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}));
 const parts=Object.fromEntries(clockFormatters.get(zone).formatToParts(new Date(value)).map(p=>[p.type,p.value]));
 return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
for(const folder of ['network','official-browser']){
 const manifest=read(`${root}/${folder}/evidence-hashes.json`);
 for(const [file,expected] of Object.entries(manifest)){
  assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'),expected);hashes++;
 }
 for(const r of read(`${root}/${folder}/candidate-flights.json`).records){
  assert.ok(r.date>='2026-10-21'&&r.date<='2026-12-31');
  assert.equal(r.airlineCode,'CI');assert.ok(r.origin==='TPE'||r.destination==='TPE');
  assert.equal((Date.parse(r.arrival)-Date.parse(r.departure))/60000,r.minutes);
  assert.equal(new Intl.DateTimeFormat('en-CA',{timeZone:r.departureTimeZone}).format(new Date(r.departure)),r.date);
  assert.equal(zonedMinute(r.departure,r.departureTimeZone),r.departure.slice(0,16));
  assert.equal(zonedMinute(r.arrival,r.arrivalTimeZone),r.arrival.slice(0,16));
  assert.equal(manifest[r.evidence.file],r.evidence.sha256);
  const key=[r.date,r.number,r.origin,r.destination].join('|');
  if(!groups.has(key))groups.set(key,{identity:key,observations:[]});
  groups.get(key).observations.push(r);observations++;
 }
}
let conflicts=0;
for(const group of groups.values()){
 group.requiresReview=new Set(group.observations.map(r=>r.departure+'|'+r.arrival)).size>1;
 if(group.requiresReview)conflicts++;
}
const checked=new Set(read(root+'/network/coverage.json').map(r=>`${r.origin}-${r.destination}-${r.date}`));
for(const id of read(root+'/official-browser/covered-date-groups.json'))checked.add(id);
const routeSummary=progress.airports.map(airport=>{
 const outDates=[...checked].filter(id=>id.startsWith(`TPE-${airport}-`));
 const inDates=[...checked].filter(id=>id.startsWith(`${airport}-TPE-`));
 const flights=[...groups.values()].map(group=>group.observations[0]);
 return {airport,outboundFlights:flights.filter(r=>r.origin==='TPE'&&r.destination===airport).length,
  returnFlights:flights.filter(r=>r.origin===airport&&r.destination==='TPE').length,
  outboundDatesChecked:outDates.length,returnDatesChecked:inDates.length,
  completeDateCoverage:outDates.length===72&&inDates.length===72,
  note:'Checked dates describe source coverage; dates with no listed flights are not proof that no flight operates.'};
});
const report={state:progress.state,uniqueFlights:groups.size,sourceObservations:observations,
 duplicateSourceObservations:observations-groups.size,conflicts,rawFilesRehashed:hashes,
 auditedSourceGroups:parsed.checkedDateGroups,sourceGroupsCompleted:Object.keys(progress.completed).length,sourceGroupsPending:progress.pending.length,
 sourceGroupsSatisfiedByOfficial:Object.keys(progress.satisfiedByOfficial||{}).length,
 sourceGroupsUnqueried:progress.expected-Object.keys(progress.completed).length-progress.pending.length-Object.keys(progress.satisfiedByOfficial||{}).length,
 baselineAirports:progress.airports.length,allNetworkComplete:false,integratedIntoWebsite:false,
 plannedQueryGroups:progress.expected,
 plannedDateCoverageComplete:routeSummary.every(r=>r.completeDateCoverage)&&progress.pending.length===0&&parsed.parsePending===0,
 officialTimetableSourceState:officialStop?.state||'not_stopped',
 unresolvedPublishedFrequencyDifferences:frequencyClaims?.differences.length||0,
 checkedAt:new Date().toISOString(),activeCollectionScope:'TPE international CI primary direct flights, both directions through 2026-12-31; codeshare observations retained separately'};
fs.writeFileSync(root+'/consolidated-candidates.json',JSON.stringify({groups:[...groups.values()]},null,2));
fs.writeFileSync(root+'/coverage-summary.json',JSON.stringify({fromDate:'2026-10-21',through:'2026-12-31',routes:routeSummary,allNetworkComplete:false,integratedIntoWebsite:false},null,2));
const names={NRT:'東京成田',KIX:'大阪關西',CTS:'札幌新千歲',NGO:'名古屋中部',HIJ:'廣島',TAK:'高松',FUK:'福岡',KMJ:'熊本',OKA:'沖繩那霸',ICN:'首爾仁川',PUS:'釜山',BKK:'曼谷蘇凡納布',CNX:'清邁',KUL:'吉隆坡',PEN:'檳城',SIN:'新加坡',CGK:'雅加達',DPS:'峇里島',SGN:'胡志明市',DAD:'峴港',HAN:'河內',KTI:'金邊德崇',ROR:'帛琉',MNL:'馬尼拉',HKG:'香港',PEK:'北京首都',PVG:'上海浦東',SZX:'深圳',XMN:'廈門',LAX:'洛杉磯',ONT:'安大略',PHX:'鳳凰城',SFO:'舊金山',JFK:'紐約甘迺迪',YVR:'溫哥華',SYD:'雪梨',BNE:'布里斯本',FRA:'法蘭克福',LHR:'倫敦希斯洛',VIE:'維也納',KOJ:'鹿兒島',CEB:'宿霧',CAN:'廣州',SEA:'西雅圖',MEL:'墨爾本',AMS:'阿姆斯特丹',PRG:'布拉格',FCO:'羅馬',RGN:'仰光',TOY:'富山',CTU:'成都雙流',TFU:'成都天府'};
Object.assign(names,{CKG:'重慶',NKG:'南京',HGH:'杭州',WUX:'無錫',ISG:'石垣島'});
const markdown=[
 '# 桃園華航蒐集覆蓋表', '',
 `核對時間：${report.checkedAt}。日期範圍：2026/10/21～12/31，各方向 72 個日期。`, '',
 `目前有 ${report.uniqueFlights.toLocaleString('en-US')} 個不重複航班身份、${report.sourceObservations.toLocaleString('en-US')} 個來源觀察；起降時間衝突 ${report.conflicts} 個。尚未匯入網站。`, '',
 `既定候選範圍：${progress.airports.length} 個機場、${progress.expected.toLocaleString('en-US')} 組日期方向。${report.plannedDateCoverageComplete?'全部日期方向已有查詢證據；不再重複蒐集已完成項目。':'仍有日期方向待確認。'}`, '',
 '筆數依「日期＋班號＋起點＋終點」去重，包含明示的共用班號，不代表實際飛機或可售機位數。查過日期表示保存了該日來源證據，不保證來源已收錄所有航班。0 筆不等於沒有航班。', '',
 '已查日期只計明確查詢的機場；城市搜尋額外列出的鄰近機場航班依實際代碼保留，不據此認定鄰近機場的全部日期都已查完。例如洛杉磯結果中的 ONT 不會標成 LAX。', '',
 '| 航點 | 去程筆數 | 回程筆數 | 去程已查日期 | 回程已查日期 | 日期範圍查詢 |',
 '|---|---:|---:|---:|---:|---|',
 ...routeSummary.map(r=>`| ${names[r.airport]||r.airport} ${r.airport} | ${r.outboundFlights} | ${r.returnFlights} | ${r.outboundDatesChecked}/72 | ${r.returnDatesChecked}/72 | ${r.completeDateCoverage?'已查完整段':'尚有缺口'} |`), '',
 `${progress.airports.length} 個機場是歷史航網與官方航點圖的候選清單，仍需逐日確認實際桃園航線與承運公司；成都兩個機場是探索查詢。不能據此宣稱全航網齊全。`, '',
 `華航官方週表來源狀態：${report.officialTimetableSourceState}。另有 ${report.unresolvedPublishedFrequencyDifferences} 項公開公告的飛行星期差異待核對，未生成每日航班；詳見 published-oceania/frequency-observations.json。`, '',
 '正式依據保留於 consolidated-candidates.json 的每筆 observations；來源時間不同或內容不同均保留，未以舊資料覆蓋新證據。',
];
fs.writeFileSync(root+'/COVERAGE.md',markdown.join('\n')+'\n');
fs.writeFileSync(root+'/independent-network-audit.json',JSON.stringify(report,null,2));
fs.writeFileSync(root+'/RESEARCH_STATUS.json',JSON.stringify({...report,progressFile:'network/progress.json',resumeScript:'scripts/crawler/continue-ci-network-20261021.ps1',resumeCommand:'& .\\scripts\\crawler\\continue-ci-network-20261021.ps1 -Resume',note:progress.state==='paused_by_user'?'Paused at explicit user request. Do not resume without a new user instruction; use -Resume for the recorded pause control.':'Audited snapshot only; live collection can be ahead. Do not launch a second collector while the current one is active.'},null,2));
console.log(JSON.stringify(report));
