import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
const [,, planFile, outDir, limit] = process.argv;
let plan = JSON.parse(fs.readFileSync(planFile,'utf8'));
if (limit) plan = plan.slice(0, +limit);
const code = e => [...e].map(c=>c.codePointAt(0)).filter(c=>c!==0xfe0f).map(c=>c.toString(16)).join('-');
const uri = e => 'data:image/svg+xml;base64,'+fs.readFileSync(`svg/${code(e)}.svg`).toString('base64');
const html = p => `<!doctype html><html><head><style>
*{margin:0;box-sizing:border-box}
body{width:640px;height:480px;overflow:hidden;background:#5b3b2e}
.bg{position:absolute;inset:-200px;background:repeating-conic-gradient(from 0deg at 50% 50%,#6a4535 0 6deg,#57382b 6deg 15deg);}
.vig{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 55%,rgba(0,0,0,0) 40%,rgba(0,0,0,.35) 100%)}
.plate{position:absolute;left:70px;top:150px;width:500px;height:300px;border-radius:50%;background:#f4f1ec;border:4px solid #3a2a22;box-shadow:0 10px 0 rgba(0,0,0,.25)}
.plate::after{content:'';position:absolute;inset:26px 34px;border-radius:50%;background:#e2ded7;box-shadow:inset 0 3px 0 rgba(0,0,0,.08)}
.main{position:absolute;left:200px;top:140px;width:240px;height:240px;filter:drop-shadow(0 0 0 #3a2a22) drop-shadow(3px 6px 0 rgba(0,0,0,.28))}
.bowl{position:absolute;left:36px;top:34px;width:200px;height:120px;border-radius:50%;background:#f4f1ec;border:4px solid #3a2a22;box-shadow:0 6px 0 rgba(0,0,0,.25)}
.bowl::after{content:'';position:absolute;inset:14px 20px;border-radius:50%;background:#e2ded7}
.i1{position:absolute;left:86px;top:38px;width:100px;height:100px;z-index:2;filter:drop-shadow(2px 4px 0 rgba(0,0,0,.25))}
.i2{position:absolute;right:52px;top:40px;width:120px;height:120px;filter:drop-shadow(3px 5px 0 rgba(0,0,0,.28))}
.i2b{position:absolute;right:140px;top:80px;width:84px;height:84px;filter:drop-shadow(3px 5px 0 rgba(0,0,0,.28))}
</style></head><body><div class="bg"></div><div class="vig"></div>
${p.ings[0]?`<div class="bowl"></div><img class="i1" src="${uri(p.ings[0])}">`:''}
${p.ings[1]?`<img class="i2" src="${uri(p.ings[1])}"><img class="i2b" src="${uri(p.ings[1])}">`:''}
<div class="plate"></div><img class="main" src="${uri(p.dish)}"></body></html>`;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const pg = await b.newPage({ viewport:{width:640,height:480} });
fs.mkdirSync(outDir,{recursive:true});
for (const p of plan){
  await pg.setContent(html(p));
  await pg.screenshot({ path: `${outDir}/${p.file}`, type:'jpeg', quality:82 });
}
await b.close(); console.log('ok', plan.length);
