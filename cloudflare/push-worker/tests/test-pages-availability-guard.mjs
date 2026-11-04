import assert from 'node:assert/strict';
import {probePagesAvailability,classifyPagesAvailability,HEALTH_POLICY_VERSION} from '../src/health-monitor.js';
import {buildActionCenter} from '../src/health-action-center.js';

const now=Date.parse('2026-11-04T18:10:15.367Z');
const okResponse=(status=200,contentType='text/html; charset=utf-8')=>({
  status,headers:{get:(k)=>k.toLowerCase()==='content-type'?contentType:null}
});
assert.equal(HEALTH_POLICY_VERSION,14);
const direct=await probePagesAvailability('https://formuladogol.com.br',async()=>okResponse());
assert.equal(direct.ok,true);
assert.equal(direct.checks.length,1,'healthy primary path needs only one request');
const errors=[];
const oneFailed=await probePagesAvailability('https://formuladogol.com.br',async url=>{
  errors.push(url);
  if(url.endsWith('/')) throw new Error('transient fetch from Cloudflare Worker');
  return okResponse();
});
assert.equal(oneFailed.ok,true,'secondary HTML route recovers a single network error');
assert.equal(oneFailed.checks.length,2);
assert.equal(classifyPagesAvailability(oneFailed,null,now).severity,'green');
assert.deepEqual(errors,[
  'https://formuladogol.com.br/',
  'https://formuladogol.com.br/index.html'
]);
const allFailed=await probePagesAvailability('https://formuladogol.com.br',async()=>{throw new Error('temporary DNS');});
assert.equal(allFailed.ok,false);
assert.equal(allFailed.checks.length,2);
const first=classifyPagesAvailability(allFailed,null,now);
assert.equal(first.severity,'yellow');
assert.equal(first.failedCycles,1);
assert.match(first.detail,/observação/);
const firstSnap={at:new Date(now).toISOString(),pagesAvailability:first};
const repeatedImmediately=classifyPagesAvailability(allFailed,firstSnap,now+20_000);
assert.equal(repeatedImmediately.severity,'yellow','same cycle must not escalate');
const second=classifyPagesAvailability(allFailed,firstSnap,now+5*60_000);
assert.equal(second.severity,'red','consecutive cycles prove outage');
assert.equal(second.failedCycles,2);
const afterStale=classifyPagesAvailability(allFailed,firstSnap,now+20*60_000);
assert.equal(afterStale.severity,'yellow','an old failure is not current evidence');
const recovered=classifyPagesAvailability(direct,{
  at:new Date(now+5*60_000).toISOString(),pagesAvailability:second
},now+10*60_000);
assert.equal(recovered.severity,'green');
assert.equal(recovered.failedCycles,0);
const http500=await probePagesAvailability('https://formuladogol.com.br',async()=>okResponse(500));
assert.equal(http500.ok,false);
assert.equal(classifyPagesAvailability(http500,null,now).severity,'yellow');
const invalidHTML=await probePagesAvailability('https://formuladogol.com.br',async()=>okResponse(200,'application/json'));
assert.equal(invalidHTML.ok,false,'a 200 JSON response is not a homepage');
const yellowAction=buildActionCenter({indicators:[{id:'site',label:'Site / Pages',severity:first.severity,detail:first.detail}]},now);
assert.equal(yellowAction.requiresAttention.find(x=>x.id==='site')?.severity,'yellow');
assert.equal(yellowAction.requiresAttention.find(x=>x.id==='site')?.responsibility,'AUTO');
const redAction=buildActionCenter({indicators:[{id:'site',label:'Site / Pages',severity:second.severity,detail:second.detail}]},now);
assert.equal(redAction.requiresAttention.find(x=>x.id==='site')?.severity,'red');
assert.equal(redAction.requiresAttention.find(x=>x.id==='site')?.responsibility,'MANUAL');
console.log('PASS: FDG Pages false RED guard, dual-path HTTP probe, 2-cycle confirmation, recovery, true outage alert');
