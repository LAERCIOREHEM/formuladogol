import assert from 'node:assert/strict';
import { evaluateSpend, evaluateD1Rows, COST_SHIELD_POLICY, CostShieldState, allowEssentialSportsWhileBillingStale, essentialSportsRoute } from '../src/cost-shield.js';

const t=Date.parse('2026-11-19T12:00:00Z');
const start='2026-11-19T00:00:00.000Z';
const samples=[{ts:t-25*3_600_000,cycleStart:start,costUsd:0.5},
 {ts:t-2*3_600_000,cycleStart:start,costUsd:1.5},
 {ts:t-30*60_000,cycleStart:start,costUsd:2},
 {ts:t,cycleStart:start,costUsd:4.2}];
assert.equal(evaluateSpend(samples,t).reason,'hourly_limit');
assert.equal(evaluateSpend(samples,t).hourlyUsd,2.7);
assert.equal(evaluateSpend(samples,t).dailyUsd,3.7);
assert.equal(evaluateSpend([{ts:t,cycleStart:start,costUsd:10}],t).reason,'cycle_limit');
assert.equal(evaluateSpend([{ts:t,cycleStart:start,costUsd:1}],t).reason,null);
assert.equal(evaluateSpend([],t).ok,false);
assert.equal(evaluateD1Rows([{sum:{rowsRead:5_000_000_001,rowsWritten:2}}]).reason,'d1_daily_rows_read');
assert.equal(evaluateD1Rows([{sum:{rowsRead:1,rowsWritten:10_000_001}}]).reason,'d1_daily_rows_written');
assert.equal(COST_SHIELD_POLICY.dailyStopUsd,5);
let store={};
const stub={storage:{get:async key=>store[key],put:async(key,value)=>{store[key]=structuredClone(value)}}};
const shield=new CostShieldState(stub);
const r=await shield.fetch(new Request('https://test.internal/sample',{method:'POST',
  body:JSON.stringify({now:t,report:{ok:true,cycleStart:start,costUsd:10.1},d1:null})}));
assert.equal((await r.json()).halted,true);
const s=await shield.fetch(new Request('https://test.internal/status'));
assert.equal((await s.json()).halted,true);
const reset=await shield.fetch(new Request('https://test.internal/reset',{method:'POST'}));
assert.equal(reset.status,409);
console.log('CF-COST-SHIELD R1 tests passed');

// R35 live-incident regression: stale billing must not silently disable
// soccer scores/push, but true spending limits and unknown state still win.
const stale={halted:true,reason:'billing_monitor_stale',cycleUsd:null,dailyUsd:null,hourlyUsd:null,d1Read:null,d1Written:null};
assert.equal(allowEssentialSportsWhileBillingStale(stale),true);
assert.equal(essentialSportsRoute('GET','/v1/live/state'),true);
assert.equal(essentialSportsRoute('GET','/v1/live/summary'),true);
assert.equal(essentialSportsRoute('POST','/v1/subscribe'),true);
assert.equal(essentialSportsRoute('POST','/v1/cost-shield/reset'),false);
assert.equal(essentialSportsRoute('GET','/v1/postgame/search-probe'),false);
assert.equal(essentialSportsRoute('GET','/v1/ops-intelligence/search'),false);
for (const reason of ['cycle_limit','hourly_limit','rolling_24h_limit','d1_daily_rows_read','d1_daily_rows_written','state_unavailable']) {
  assert.equal(allowEssentialSportsWhileBillingStale({...stale,reason}),false,reason);
}
for (const [key,value] of [['cycleUsd',10],['dailyUsd',5],['hourlyUsd',2],['d1Read',5_000_000_000],['d1Written',10_000_000]]) {
  assert.equal(allowEssentialSportsWhileBillingStale({...stale,[key]:value}),false,key);
}
console.log('Essential sports cost-shield emergency lane tests passed');
