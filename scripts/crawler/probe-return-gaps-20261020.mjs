import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='data/source-samples/crawler/return-gaps-20261020';
await fs.mkdir(root,{recursive:true});
for(const [name,url] of [
  ['eva','https://booking.evaair.com/flyeva/eva/b2c/flight-schedules.aspx?lang=en-hk'],
  ['jta','https://www.jal.co.jp/tw/en/offers/okinawa-jta/'],
  ['tigerair','https://api-cms.tigerairtw.com/api/flight-schedules/merge'],
  ['jta-company-winter','https://jta-okinawa.com/cms/wp-content/uploads/2026/08/26029-JTA%E3%83%BBRAC%E3%80%812026%E5%B9%B4%E5%BA%A6%E4%B8%8B%E6%9C%9F%E8%B7%AF%E7%B7%9A%E4%BE%BF%E6%95%B0%E8%A8%88%E7%94%BB%E3%82%92%E6%B1%BA%E5%AE%9A-2.pdf'],
  ['jta-company-summer','https://jta-okinawa.com/cms/wp-content/uploads/2026/02/25070-1.pdf'],
]) {
  const stem=`${root}/${name}`;
  try {await fs.access(stem+'.started.json'); console.log(name+': saved attempt; skipped');continue;}catch(e){if(e.code!=='ENOENT')throw e;}
  await fs.writeFile(stem+'.started.json',JSON.stringify({url,startedAt:new Date().toISOString()}),{flag:'wx'});
  let receipt={url,attemptedAt:new Date().toISOString(),retry:false};
  try {
    const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(25000)});
    const body=Buffer.from(await response.arrayBuffer());
    await fs.writeFile(stem+'.body',body,{flag:'wx'});
    receipt={...receipt,status:response.status,sha256:createHash('sha256').update(body).digest('hex'),bytes:body.length,
      state:response.status===200&&!/captcha|access denied|verify you are human/i.test(body.toString())?'received_needs_inspection':'stopped_source_unavailable'};
  }catch(error){receipt={...receipt,state:'stopped_source_unavailable',reason:error.message,cause:error.cause?.code};}
  await fs.writeFile(stem+'.receipt.json',JSON.stringify(receipt,null,2));
  console.log(JSON.stringify({name,...receipt}));
}
