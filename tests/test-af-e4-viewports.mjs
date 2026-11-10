import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium, webkit, devices } from 'playwright';

const source = readFileSync('acuracia.html','utf8');
const before = '<section class="panel accuracy-section af-e4-section"';
const after = '<section class="panel accuracy-section" aria-labelledby="accuracy-timeline-title">';
const start = source.indexOf(before), end = source.indexOf(after,start);
assert.ok(start>0 && end>start, 'section E4 incompleta');
const section = source.slice(start,end);
const css = [
  readFileSync('css/br-global.css','utf8'),
  readFileSync('css/br-acuracia.css','utf8'),
  readFileSync('css/br-acuracia-insights.css','utf8'),
  readFileSync('css/br-acuracia-placares-e4.css','utf8')
].join('\n');
const code = readFileSync('js/br-acuracia-placares-e4.js','utf8');
const data = readFileSync('dados-br/acuracia-placares-af-2026.json','utf8');
const html = `<!doctype html><html lang="pt-BR"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>*{box-sizing:border-box}body{margin:0;background:#07131a;color:#eff7fe}
  main{width:min(100% - 20px,1180px);margin:12px auto;min-width:0}
  .panel{width:100%;max-width:100%;min-width:0;border:1px solid #233a49;border-radius:16px;background:#0d1b25}
  .panel-inner{padding:18px;min-width:0}</style>
  <style>${css}</style></head><body><main>${section}</main>
  <script>${code}</script></body></html>`;
const cases = [
  {name:'desktop-1440',engine:chromium,config:{viewport:{width:1440,height:900}}},
  {name:'tablet-768',engine:chromium,config:{viewport:{width:768,height:1024}}},
  {name:'android-pixel7',engine:chromium,config:devices['Pixel 7']},
  {name:'iphone13-webkit',engine:webkit,config:devices['iPhone 13']},
  {name:'iphone-se-webkit',engine:webkit,config:devices['iPhone SE']},
  {name:'android-320',engine:chromium,config:{viewport:{width:320,height:800},isMobile:true,hasTouch:true}}
];
mkdirSync('test-results/af-e4',{recursive:true});
for(const test of cases) {
  const browser=await test.engine.launch({headless:true});
  try {
    const ctx=await browser.newContext(test.config);
    const page=await ctx.newPage();
    const issues=[];
    page.on('pageerror',error=>issues.push(error.message));
    await page.route('https://e4.internal/**',async route=>{
      const url=route.request().url();
      if(url.includes('/dados-br/acuracia-placares-af-2026.json')) {
        await route.fulfill({status:200,contentType:'application/json',body:data});
      } else {
        await route.fulfill({status:200,contentType:'text/html',body:html});
      }
    });
    await page.goto('https://e4.internal/acuracia.html',{waitUntil:'domcontentloaded'});
    await page.waitForSelector('.af-e4-kpi strong',{timeout:15000});
    assert.equal(await page.locator('.af-e4-kpi').count(),4,test.name);
    const status=await page.locator('#af-e4-status').innerText();
    assert.match(status,/certificada/,test.name);
    const initial=await page.locator('#af-e4-summary').innerText();
    assert.match(initial,/157/,test.name);
    await page.locator('#af-e4-calibration-type').selectOption('top3');
    assert.match(await page.locator('#af-e4-calibration-reading').innerText(),/O modelo esperava/,test.name);
    await page.locator('#af-e4-club').selectOption({index:1});
    assert.notEqual(await page.locator('#af-e4-club').inputValue(),'');
    await page.locator('#af-e4-round').selectOption({index:1});
    assert.notEqual(await page.locator('#af-e4-round').inputValue(),'');
    await page.locator('#af-e4-round').selectOption('');
    await page.locator('#af-e4-club').selectOption('');
    const status2=await page.locator('#af-e4-summary').innerText();
    assert.match(status2,/157/,test.name);
    const width=await page.evaluate(()=>{
      const section=document.querySelector('.af-e4-section');
      const rect=section.getBoundingClientRect();
      return {
        viewport:window.innerWidth,
        scrollWidth:document.documentElement.scrollWidth,
        sectionWidth:rect.width,
        overflow:[...section.querySelectorAll('*')].filter(el=>{
          const box=el.getBoundingClientRect();
          return box.width > 0 && (box.left < -1 || box.right > window.innerWidth+1);
        }).slice(0,8).map(el=>el.id||el.className||el.tagName)
      };
    });
    assert.ok(width.scrollWidth <= width.viewport + 1,test.name+' page overflow '+JSON.stringify(width));
    assert.equal(width.overflow.length,0,test.name+' element overflow '+JSON.stringify(width));
    assert.equal(issues.length,0,test.name+' runtime exceptions '+issues.join(', '));
    await page.screenshot({path:'test-results/af-e4/'+test.name+'.png',fullPage:true});
    console.log('AF E4 VIEWPORT PASS',test.name,width.viewport);
    await ctx.close();
  } finally { await browser.close(); }
}
