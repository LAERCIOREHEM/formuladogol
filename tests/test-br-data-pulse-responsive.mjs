import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {chromium} from 'playwright';
const css=readFileSync('css/br-data-pulse.css','utf8'),js=readFileSync('js/br-data-pulse.js','utf8');
const browser=await chromium.launch({headless:true});
const states=[{}, {pending:true,processed:356}, {live:true}, {late:true}, {certified:false}];
const base={updatedAt:'2026-11-23T22:20:03-03:00',processed:358,expected:358,seasonCompleted:358,seasonTotal:380,certified:true};
mkdirSync('artifacts/data-pulse',{recursive:true});
try{
 for(const width of [320,360,390,430,768,1024,1440]){
  const page=await browser.newPage({viewport:{width,height:900}});
  await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:8px;font:16px Arial;background:#061016}'+css+'</style><main id="slot"></main>');
  await page.addScriptTag({content:js});
  for(const count of [0,1,2,3,4]){
   for(const state of states){
    await page.evaluate(({base,count,state})=>FDGDataPulse.mount(document.querySelector('#slot'),{...base,...state,metrics:Array.from({length:count},(_,i)=>({label:'Estatísticas detalhadas '+i,value:'2.000.000',detail:'Informações documentais disponíveis'})),note:'Classificação ao vivo; percentuais do último cálculo.'}),{base,count,state});
    const check=await page.evaluate(()=>{
      const panel=document.querySelector('.fdg-pulse'),grid=panel.querySelector('.fdg-pulse-grid');
      const bounds=panel.getBoundingClientRect();
      return {width:document.documentElement.scrollWidth,viewport:innerWidth,
        panelOverflow:panel.scrollWidth>panel.clientWidth+1,
        columns:getComputedStyle(grid).gridTemplateColumns.split(' ').length,
        clipped:[...panel.querySelectorAll('.fdg-pulse-metric,.fdg-pulse-status')].some(e=>e.scrollWidth>e.clientWidth+1||e.getBoundingClientRect().right>bounds.right+1),
        font:parseFloat(getComputedStyle(panel.querySelector('.fdg-pulse-metric strong')).fontSize)};
    });
    assert.ok(check.width<=check.viewport+1&&!check.panelOverflow&&!check.clipped,JSON.stringify({width,count,state,check}));
    assert.ok(check.font>=18);
    if(width<=430)assert.equal(check.columns,2);
   }
  }
  await page.screenshot({path:'artifacts/data-pulse/'+width+'.png',fullPage:true});
  // A narrow nested container on desktop must adapt to its own width.
  await page.evaluate(()=>document.querySelector('#slot').style.width='240px');
  assert.equal(await page.locator('.fdg-pulse-grid').evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length),1);
  await page.close();
 }
}finally{await browser.close()}
console.log('PASS Responsive Intelligence: 175 combinations and nested narrow containers');
