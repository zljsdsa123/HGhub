// Repeatable interaction probe with local IPC fixtures; reports are not native device benchmarks.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { installFixture } from './fixtures/app-ui.mjs';
const root = new URL('../', import.meta.url).pathname;
const output = `${root}test-results/ui-performance/${Date.now()}`;
await mkdir(output, {recursive:true});
const server = await createServer({root,server:{host:'127.0.0.1',port:0}});
let browser;
try {
 await server.listen();
 browser = await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE || undefined});
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.1 Mobile/15E148 Safari/604.1'});
 await page.addInitScript(installFixture,{theme:'light',titles:['城市与晚风','重逢在夏日以后','星河旅人','无声的答案','我的奇妙假期','晴天来信']});
 await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#789"/></svg>'}));
 await page.goto(server.resolvedUrls.local[0]);
 await page.getByRole('navigation',{name:'主导航'}).waitFor();
 const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 const samples=[];
 for(let i=0;i<18;i++) {
  const label=['搜索','分类','我的'][i%3];
  samples.push(await page.evaluate(async label=>{
   const button=[...document.querySelectorAll('nav[aria-label="主导航"] button')].find(b=>b.textContent===label);
   const start=performance.now();button.click();
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   return {label,ms:Math.round((performance.now()-start)*10)/10,committed:button.getAttribute('aria-current')==='page'};
  },label));
 }
 const times=samples.map(x=>x.ms).sort((a,b)=>a-b);
 const report={environment:'Chromium dev build; 4x CPU slowdown; local IPC; click dispatch to two animation frames',samples,p50:times[Math.floor(times.length*.5)],p95:times[Math.floor(times.length*.95)]};
 await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 assert(samples.every(s=>s.committed),'Navigation commits before the next paint');
} finally {await browser?.close();await server.close();}
