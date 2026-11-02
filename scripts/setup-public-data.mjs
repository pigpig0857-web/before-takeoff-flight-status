import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templates=JSON.parse(fs.readFileSync(path.join(root,'scripts/public-data-templates.json'),'utf8'));
fs.mkdirSync(path.join(root,'src/server/data'),{recursive:true});
let added=0;
for(const [name,value] of Object.entries(templates)){
 const target=path.join(root,'src/server/data',name);
 if(!fs.existsSync(target)){ fs.writeFileSync(target,JSON.stringify(value)+'\n'); added++; }
}
console.log(`Prepared ${added} empty local data files; existing data preserved.`);
