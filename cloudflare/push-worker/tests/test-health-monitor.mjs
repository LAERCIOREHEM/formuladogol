import assert from 'node:assert/strict';
import { countWebSearchCalls, estimateProviderCost } from '../src/ai-usage.js';
import { dailyDigestDecision, githubActionsSeverity, isDailyDigestDue, summarizeCloudflareWorkersUsage, postgameDigestLines } from '../src/health-monitor.js';

assert.equal(countWebSearchCalls({output:[{type:'web_search_call'},{type:'message'},{type:'web_search_call'}]}),2);
assert.equal(countWebSearchCalls({}),0);

assert.equal(githubActionsSeverity({dormant:true,dispatches:4,previousDispatches:4,pendingPostgameTasks:0,hoursToNext:240,hasPrevious:true}).severity,'green');
assert.equal(githubActionsSeverity({dormant:true,dispatches:5,previousDispatches:4,pendingPostgameTasks:0,hoursToNext:240,hasPrevious:true}).severity,'red');
assert.equal(githubActionsSeverity({dormant:true,dispatches:4,previousDispatches:0,pendingPostgameTasks:0,hoursToNext:240,hasPrevious:false}).severity,'green');
assert.equal(githubActionsSeverity({dormant:false,dispatches:9,previousDispatches:8,pendingPostgameTasks:1,hoursToNext:1,hasPrevious:true}).severity,'yellow');

// Janela normal + recuperação controlada até 11:59 BRT.
assert.equal(isDailyDigestDue({date:'2026-09-26',hour:8,minute:1},''),true);
assert.equal(isDailyDigestDue({date:'2026-09-26',hour:11,minute:59},''),true);
assert.equal(isDailyDigestDue({date:'2026-09-26',hour:12,minute:0},''),false);
assert.equal(isDailyDigestDue({date:'2026-09-26',hour:23,minute:5},''),false);
assert.equal(isDailyDigestDue({date:'2026-09-26',hour:8,minute:5},'2026-09-26'),false);

const now=Date.parse('2026-09-26T14:22:00Z'); // 11:22 BRT
assert.equal(dailyDigestDecision({date:'2026-09-26',hour:11,minute:22},'',{now}).due,true);
assert.equal(dailyDigestDecision({date:'2026-09-26',hour:11,minute:22},'',{now,lastAttemptAt:'2026-09-26T14:12:00Z'}).state,'retry_wait');
assert.equal(dailyDigestDecision({date:'2026-09-26',hour:11,minute:22},'',{now,lastAttemptAt:'2026-09-26T14:06:00Z'}).due,true);
assert.equal(dailyDigestDecision({date:'2026-09-26',hour:12,minute:0},'',{now}).state,'missed');
assert.equal(dailyDigestDecision({date:'2026-09-26',hour:11,minute:22},'2026-09-26',{now}).state,'sent');

// Uso agregado Workers Paid: billing diário + ciclo mensal + projeção.
const usage=summarizeCloudflareWorkersUsage([
  {
    ServiceFamilyName:'Workers', x_BillableMetricName:'Workers Standard CPU Time',
    ChargeDescription:'Workers Standard CPU Time — daily usage', ConsumedQuantity:100000, ConsumedUnit:'Milliseconds',
    ChargePeriodStart:'2026-09-25T00:00:00Z', BillingPeriodStart:'2026-09-19T00:00:00Z', BillingPeriodEnd:'2026-10-19T00:00:00Z', BilledCost:0
  },
  {
    ServiceFamilyName:'Workers', x_BillableMetricName:'Workers Standard CPU Time',
    ChargeDescription:'Workers Standard CPU Time — daily usage', ConsumedQuantity:77246, ConsumedUnit:'Milliseconds',
    ChargePeriodStart:'2026-09-26T00:00:00Z', BillingPeriodStart:'2026-09-19T00:00:00Z', BillingPeriodEnd:'2026-10-19T00:00:00Z', BilledCost:0
  },
  {
    ServiceFamilyName:'Workers', x_BillableMetricName:'Workers Standard Requests',
    ChargeDescription:'Workers Standard Requests — daily usage', ConsumedQuantity:30000, ConsumedUnit:'Requests',
    ChargePeriodStart:'2026-09-25T00:00:00Z', BillingPeriodStart:'2026-09-19T00:00:00Z', BillingPeriodEnd:'2026-10-19T00:00:00Z', BilledCost:0
  },
  {
    ServiceFamilyName:'Workers', x_BillableMetricName:'Workers Standard Requests',
    ChargeDescription:'Workers Standard Requests — daily usage', ConsumedQuantity:14900, ConsumedUnit:'Requests',
    ChargePeriodStart:'2026-09-26T00:00:00Z', BillingPeriodStart:'2026-09-19T00:00:00Z', BillingPeriodEnd:'2026-10-19T00:00:00Z', BilledCost:0
  },
  { ServiceFamilyName:'R2', x_BillableMetricName:'R2 Class A', ConsumedQuantity:999999, ConsumedUnit:'Requests', ChargePeriodStart:'2026-09-26T00:00:00Z', BilledCost:9 }
],now);
assert.equal(usage.cpuMs,177246);
assert.equal(usage.todayCpuMs,77246);
assert.equal(usage.requests,44900);
assert.equal(usage.todayRequests,14900);
assert.equal(Number(usage.cpuUsedPct.toFixed(3)),0.591);
assert.equal(Number(usage.requestUsedPct.toFixed(3)),0.449);
assert.equal(usage.billedCost,0); // R2 não entra no bloco Workers.
assert.equal(usage.currentOverageUsd,0);
assert.ok(usage.projectedCpuMs>usage.cpuMs);


const openaiCost=estimateProviderCost({provider:'openai',model:'gpt-5.6-terra',searches:2,input_tokens:1000,output_tokens:500},{});
assert.ok(openaiCost.knownUsd>0.02);
const hunterLines=postgameDigestLines({
  pending:1,searching:0,overdue:1,budgetGuard:0,resolved:277,persistentUntilResolved:true,
  pendingRows:[{eventId:'401841169',home:'São Paulo',away:'Santos',homeScore:1,awayScore:2,round:21,finalAt:'2026-10-02T23:53:00Z',publico:null,renda:null,status:'overdue',espnChecks:12,geminiAttempts:5,openaiAttempts:2,sourcesFound:4,estimatedUsd:0.06,lastAt:'2026-10-03T10:00:00Z',nextAt:'2026-10-03T11:00:00Z'}],
  cost:{last24h:{estimatedUsd:0.07},month:{estimatedUsd:1.84,byProvider:[{provider:'gemini',model:'gemini-3.5-flash-lite',calls:5,searches:5,estimatedUsd:0.07}]},budget:{monthlyBudgetUsd:10,warningPct:80}}
},Date.parse('2026-10-03T11:00:00Z'));
const hunterText=hunterLines.join('\n');
assert.match(hunterText,/PÓS-JOGO — PÚBLICO & RENDA/);
assert.match(hunterText,/São Paulo 1 x 2 Santos/);
assert.match(hunterText,/não existe GAVE_UP/);
assert.match(hunterText,/US\$ 1\.8400 \/ US\$ 10\.00/);

console.log('health-monitor/ai-usage tests: PASS');
