import assert from 'node:assert/strict';
import {
  COST_SHIELD_VERSION, COST_SHIELD_POLICY, COST_SHIELD_PROVIDER_LIMITS,
  evaluateSpend, evaluateD1Rows, billingCalendarDayUsd,
  governanceDecision, CostShieldState
} from '../src/cost-shield.js';

const t=Date.parse('2026-11-19T21:00:00Z');
const cycle='2026-11-01T00:00:00.000Z';
const samples=[
  {ts:t-25*3_600_000,cycleStart:cycle,costUsd:0.5},
  {ts:t-2*3_600_000,cycleStart:cycle,costUsd:1.0},
  {ts:t-30*60_000,cycleStart:cycle,costUsd:2.0},
  {ts:t,cycleStart:cycle,costUsd:4.2}
];
const ev=evaluateSpend(samples,t);
assert.equal(COST_SHIELD_VERSION,2);
assert.equal(ev.hourlyUsd,3.2);
assert.equal(ev.dailyUsd,3.7);
assert.equal(ev.mode,'observe');
assert.equal(evaluateSpend([...samples,{ts:t+1,cycleStart:cycle,costUsd:5.6}],t+1).mode,'optional_paused');
assert.equal(evaluateSpend([...samples,{ts:t+1,cycleStart:cycle,costUsd:10.6}],t+1).mode,'secondary_paused');
assert.equal(COST_SHIELD_POLICY.dailyPauseOptionalUsd,5);
assert.equal(COST_SHIELD_POLICY.dailyPauseSecondaryUsd,10);
assert.equal(COST_SHIELD_POLICY.monthlyProjectionWarningUsd,50);
const oneSample=evaluateSpend([{ts:t,cycleStart:cycle,costUsd:80}],t);
assert.equal(oneSample.mode,'normal','cycle cost alone is NOT a daily spend spike');
assert.equal(governanceDecision({
  halted:true,reason:'billing_monitor_stale',lastSuccessAt:0,
  lastVerifiedMode:'secondary_paused'
},t).mode,'unverified','legacy fail-closed R1 is automatically ignored');
assert.equal(governanceDecision({
  lastSuccessAt:t,lastVerifiedMode:'secondary_paused',dailyUsd:10.1
},t).essentialSportsAllowed,true);
assert.equal(governanceDecision({
  lastSuccessAt:t,lastVerifiedMode:'secondary_paused',dailyUsd:10.1
},t).optionalAllowed,false);
assert.equal(governanceDecision({
  lastSuccessAt:t,lastVerifiedMode:'optional_paused',dailyUsd:5.1
},t).secondaryAllowed,true);
assert.equal(governanceDecision({
  lastSuccessAt:t-70*60_000,lastVerifiedMode:'secondary_paused'
},t).optionalAllowed,true,'stale billing may not keep optional tasks latched forever');
assert.equal(governanceDecision({
  d1Read:5_000_000_000,d1LastSuccessAt:t,lastSuccessAt:0
},t).mode,'secondary_paused','D1 anomaly is selective, never a sports kill switch');
assert.equal(governanceDecision({
  d1Read:5_000_000_000,d1LastSuccessAt:t-70*60_000,lastSuccessAt:0
},t).mode,'unverified','stale D1 anomaly must self-recover');
assert.equal(evaluateD1Rows([{sum:{rowsRead:5_000_000_001,rowsWritten:2}}]).reason,'d1_read_anomaly');
assert.equal(evaluateD1Rows([{sum:{rowsRead:1,rowsWritten:10_000_001}}]).reason,'d1_write_anomaly');

const brtRows=[
  {BillingPeriodStart:cycle,ChargePeriodStart:'2026-11-19T13:00:00Z',BilledCost:1.25,BillingCurrency:'USD'},
  {BillingPeriodStart:cycle,ChargePeriodStart:'2026-11-19T22:00:00Z',BilledCost:0.75,BillingCurrency:'USD'},
  {BillingPeriodStart:cycle,ChargePeriodStart:'2026-11-19T01:00:00Z',BilledCost:50,BillingCurrency:'USD'}
];
assert.equal(billingCalendarDayUsd(brtRows,t,cycle),2);
assert.equal(billingCalendarDayUsd([],t,cycle),null);

const realNow=Date.now;
Date.now=()=>t;
try {
  const values={};
  const storage={
    get:async key=>values[key],
    put:async(key,value)=>{values[key]=structuredClone(value);},
    transaction:async fn=>fn(storage)
  };
  const shield=new CostShieldState({storage});
  values.status={
    createdAt:t-24*60*60_000,
    halted:true,reason:'billing_monitor_stale',lastSuccessAt:0,
    lastCheckedAt:0,samples:[]
  };
  const legacy=await (await shield.fetch(new Request('https://test/status'))).json();
  assert.equal(legacy.halted,false);
  assert.equal(legacy.mode,'unverified');
  assert.equal(legacy.optionalAllowed,true);
  assert.equal(legacy.legacyLatchIgnored,true);

  const sample=await (await shield.fetch(new Request('https://test/sample',{
    method:'POST',body:JSON.stringify({now:t,report:{ok:true,cycleStart:cycle,costUsd:15,dailyUsd:5.5},d1:null})
  }))).json();
  assert.equal(sample.mode,'optional_paused');
  assert.equal(sample.justEscalated,true);
  assert.equal(sample.essentialSportsAllowed,true);
  const repeat=await (await shield.fetch(new Request('https://test/sample',{
    method:'POST',body:JSON.stringify({now:t,report:{ok:true,cycleStart:cycle,costUsd:15,dailyUsd:5.5},d1:null})
  }))).json();
  assert.equal(repeat.justEscalated,false,'one warning for this severity/day');
  let gate=await (await shield.fetch(new Request('https://test/reserve',{
    method:'POST',body:JSON.stringify({provider:'openai',eventId:'game1',units:2,now:t})
  }))).json();
  assert.equal(gate.allowed,false,'paid AI suspended, sports continue');
  assert.equal(gate.reason,'optional_work_paused');
  const manual=await (await shield.fetch(new Request('https://test/reset',{method:'POST'}))).json();
  assert.equal(manual.automaticRecovery,true);

  // A new verified low-spend billing cycle automatically re-enables optional work.
  await shield.fetch(new Request('https://test/sample',{method:'POST',body:JSON.stringify({
    now:t+1,report:{ok:true,cycleStart:'2026-11-19T00:00:00.000Z',costUsd:0.1,dailyUsd:0.1},d1:null
  })}));
  const after=await (await shield.fetch(new Request('https://test/status'))).json();
  assert.equal(after.mode,'normal');
  assert.equal(after.optionalAllowed,true);
  assert.equal(after.legacyLatchIgnored,false);

  for(let i=0;i<3;i++){
    gate=await (await shield.fetch(new Request('https://test/reserve',{method:'POST',body:JSON.stringify({
      provider:'openai',eventId:'game1',units:2,now:t
    })}))).json();
    assert.equal(gate.allowed,true);
  }
  gate=await (await shield.fetch(new Request('https://test/reserve',{method:'POST',body:JSON.stringify({
    provider:'openai',eventId:'game1',units:1,now:t
  })}))).json();
  assert.equal(gate.allowed,false,'per-game budget blocks provider call bursts');
  gate=await (await shield.fetch(new Request('https://test/reserve',{method:'POST',body:JSON.stringify({
    provider:'unsupported',eventId:'game1',units:1,now:t
  })}))).json();
  assert.equal(gate.allowed,false);
  assert.equal(COST_SHIELD_PROVIDER_LIMITS.openai.daily,32);
  const status=await (await shield.fetch(new Request('https://test/status'))).json();
  assert.equal(status.providerUsage.openai,6);
} finally {Date.now=realNow;}
console.log('CF-COST-SHIELD R2 selective governance + provider quotas verified');
