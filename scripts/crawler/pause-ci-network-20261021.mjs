// Stop only this task's verified collector, between saved public requests.
import fs from 'node:fs/promises';
const root='data/source-samples/crawler/ci-tpe-20261021/network';
const targetPid=Number(process.argv[2]);
if(!Number.isSafeInteger(targetPid)||targetPid<=0)throw Error('A verified collector PID is required');
const read=async()=>JSON.parse((await fs.readFile(root+'/progress.json','utf8')).replace(/^\uFEFF/,''));
const until=Date.now()+120000;
while(Date.now()<until){
 let p;try{p=await read();}catch(e){if(e instanceof SyntaxError){await new Promise(r=>setTimeout(r,50));continue;}throw e;}
 if(p.state==='paused_by_user'){console.log(JSON.stringify({state:p.state,alreadyPaused:true}));process.exit(0);}
 if(p.collectionProcessId!==targetPid)throw Error('Collector identity changed; no process stopped');
 if(p.state==='collecting'){
  // Finish the route already in progress before pausing.
  if(!p.completed['DPS-TPE-2026-12-31']){await new Promise(r=>setTimeout(r,100));continue;}
  const saved=new Set([...Object.keys(p.completed),...p.pending.map(q=>q.id)]);
  const started=(await fs.readdir(root)).filter(n=>/^[A-Z]{3}-[A-Z]{3}-\d{4}-\d{2}-\d{2}\.started\.json$/.test(n));
  if(started.some(n=>!saved.has(n.replace('.started.json','')))){await new Promise(r=>setTimeout(r,50));continue;}
  process.kill(targetPid,'SIGTERM');
 }else if(p.state!=='batch_saved')throw Error('Unexpected collector state retained: '+p.state);
 p=await read();p.state='paused_by_user';p.pausedAt=new Date().toISOString();p.collectionProcessId=null;p.savedAt=p.pausedAt;
 await fs.writeFile(root+'/progress.json',JSON.stringify(p,null,2));
 console.log(JSON.stringify({state:p.state,completed:Object.keys(p.completed).length,last:Object.keys(p.completed).at(-1),pending:p.pending.length}));
 process.exit(0);
}
throw Error('No safe completed-request boundary within the wait; pause request retained');
