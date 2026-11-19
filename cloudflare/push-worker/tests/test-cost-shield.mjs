import assert from 'node:assert/strict';
import { evaluateSpend, evaluateD1Rows, COST_SHIELD_POLICY, CostShieldState } from '../src/cost-shield.js';

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
