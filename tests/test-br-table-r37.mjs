import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readFileSync,existsSync,statSync} from 'node:fs';
import {createServer} from 'node:http';
import {resolve,extname} from 'node:path';
const root=process.cwd();
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png'};
const server=createServer((req,res)=>{let p=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!p.startsWith(root+'/')&&p!==root){res.writeHead(403).end();return;}if(p===root||p.endsWith('/tabela'))p=resolve(root,'index.html');if(existsSync(p)&&statSync(p).isDirectory())p=resolve(p,'index.html');if(!existsSync(p)){res.writeHead(404).end();return;}res.setHeader('content-type',types[extname(p)]||'application/octet-stream');res.end(readFileSync(p));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:390,height:900}});
 await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
 await page.goto(origin+'/index.html?view=tabela',{waitUntil:'domcontentloaded'});
 await page.locator('#view-tabela .tabela-br tbody tr').first().waitFor({timeout:30000});
 await page.locator('#view-tabela .returno-table tbody tr').first().waitFor({timeout:30000});
 for(const width of [320,360,375,390,414,430,480,600,768,820,1024,1280,1366,1440,1920,2560]){
  await page.setViewportSize({width,height:900});
  const result=await page.evaluate(()=>{
   const checks=[];
   for(const table of document.querySelectorAll('#view-tabela :is(.tabela-br,.returno-table)')){
    const row=table.tBodies[0].rows[0], pos=row.cells[0].getBoundingClientRect(), club=row.cells[1].getBoundingClientRect();
    const names=[...table.querySelectorAll('.fdg-club-name')];
    checks.push({rows:table.tBodies[0].rows.length,pos:pos.width,gap:club.left-pos.right,full:names.length===20&&names.every(e=>{const range=document.createRange();range.selectNodeContents(e);const r=range.getBoundingClientRect(),cell=e.closest('td').getBoundingClientRect();return r.right<=cell.right+1&&r.left>=cell.left-1&&getComputedStyle(e).whiteSpace==='nowrap';})});
   }
   return checks;
  });
  assert.equal(result.length,2);
  for(const x of result){assert.equal(x.rows,20);assert.ok(x.full,JSON.stringify({width,x}));if(width<=820){assert.ok(x.pos<=46&&Math.abs(x.gap)<=1,JSON.stringify({width,x}));}}
  if(width<=820){
   for(const selector of ['.tabela-scroll','.returno-scroll']){
    const box=page.locator('#view-tabela '+selector);
    const v=await box.evaluate(e=>{
     e.scrollLeft=0;
     const table=e.querySelector('table'),cells=table.tBodies[0].rows[0].cells;
     const before=[...cells].map(c=>c.getBoundingClientRect().left);
     const available=e.clientWidth,max=Math.max(0,e.scrollWidth-available);
     const required=Math.max(0,table.getBoundingClientRect().right-e.getBoundingClientRect().left-e.clientLeft-available);
     e.scrollLeft=Math.min(160,max);
     const after=[...cells].map(c=>c.getBoundingClientRect().left);
     const gap=cells[1].getBoundingClientRect().left-cells[0].getBoundingClientRect().right;
     const actual=e.scrollLeft;
     e.scrollLeft=max;
     const last=table.tBodies[0].rows[0].cells[cells.length-1].getBoundingClientRect();
     const edge=e.getBoundingClientRect().left+e.clientLeft+available;
     const reached=last.right<=edge+2;
     e.scrollLeft=0;
     return {available,max,required,actual,gap,reached,sticky:Math.abs(after[0]-before[0])<=2&&Math.abs(after[1]-before[1])<=2,moving:Math.abs((before[2]-after[2])-actual)<=2};
    });
    const message=JSON.stringify({width,selector,v});
    assert.ok(v.available>0&&v.required<=v.max+2&&v.reached,message);
    assert.ok(Math.abs(v.gap)<=1,message);
    if(width<=430)assert.ok(v.max>2,message);
    if(v.max>2){assert.ok(v.actual>0&&v.sticky&&v.moving,message);}
    else assert.ok(v.required<=2&&v.actual===0,message);
    console.log('R37 geometry',message);
   }
  }
 }
 console.log('PASS R37-R1: 16 viewports x 2 actual tables; full names, compact POS, frozen column alignment');
}finally{await browser.close();server.close();}
