import assert from 'node:assert/strict';
import { analyticsWindows,fetchWorkersAnalyticsGraphQL,reconcileWorkersAnalytics } from '../src/workers-graphql-reconciliation.js';
import {auditCloudflareBilling,CF_BILLING_AUDIT_VERSION} from '../src/cloudflare-billing-audit.js';
import {cloudflareSeverity,cloudflareDigestLines} from '../src/health-monitor.js';
const start='2026-10-19T00:00:00.000Z',end='2026-11-19T00:00:00.000Z';
assert.equal(CF_BILLING_AUDIT_VERSION,4);
assert.equal(analyticsWindows(start,'2026-11-18T12:00:00.000Z').length,5);
assert.equal(analyticsWindows(start,'2026-12-30T00:00:00.000Z').length,0);
assert.equal((await fetchWorkersAnalyticsGraphQL({token:'',account:'abc',start,end})).reason,'analytics_read_not_configured');
const calls=[];
const valid=await fetchWorkersAnalyticsGraphQL({
  token:'test-token',account:'test-account',start,end:'2026-11-18T11:00:00.000Z',periodEnd:end,
  fetchImpl:async(url,init)=>{
    assert.equal(url,'https://api.cloudflare.com/client/v4/graphql');
    assert.equal(init.method,'POST');
    assert.equal(init.headers.Authorization,'Bearer test-token');
    const args=JSON.parse(init.body);
    assert.equal(args.variables.accountTag,'test-account');
    assert.match(args.query,/workersInvocationsAdaptive/);
    calls.push(args.variables);
    return {ok:true,json:async()=>({data:{viewer:{accounts:[{workersInvocationsAdaptive:[
      {dimensions:{scriptName:'push-formuladogol'},sum:{requests:200,cpuTimeUs:850000}},
      {dimensions:{scriptName:'orchestrator'},sum:{requests:100,cpuTimeUs:150000}}
    ]}]}}})};
  }
});
assert.equal(calls.length,5);
assert.equal(valid.status,'estimated');
assert.equal(valid.periodStart,start);
assert.equal(valid.periodEnd,end);
assert.equal(valid.windows,5);
assert.equal(valid.cpuMs,5000);
assert.equal(valid.requests,1500);
assert.equal(valid.scriptCount,2);
assert.equal(valid.billingEquivalent,false);
const billing=auditCloudflareBilling([{
  ServiceFamilyName:'Workers',ServiceName:'Workers Standard',x_BillableMetricId:'workers_standard_cpu_time',
  ConsumedQuantity:1800,ConsumedUnit:'Milliseconds',ChargePeriodStart:'2026-11-17T00:00:00Z',
  ChargePeriodEnd:'2026-11-18T00:00:00Z',BillingPeriodStart:start,BillingCurrency:'USD',BilledCost:0
},{
  ServiceFamilyName:'Workers',ServiceName:'Workers Standard',x_BillableMetricId:'workers_standard_requests',
  ConsumedQuantity:1000,ConsumedUnit:'Requests',ChargePeriodStart:'2026-11-17T00:00:00Z',
  ChargePeriodEnd:'2026-11-18T00:00:00Z',BillingPeriodStart:start,BillingCurrency:'USD',BilledCost:0
}],Date.parse('2026-11-18T12:00:00Z'));
const compare=reconcileWorkersAnalytics(billing,valid);
assert.equal(compare.comparable,true);
assert.equal(compare.cpuDifferencePct,177.78);
assert.equal(compare.requestDifferencePct,50);
assert.equal(compare.billableCertified,true);
assert.equal(billing.workers.cpuMs,1800,'GraphQL cannot override billed CPU');
assert.equal(cloudflareSeverity(billing),'green');
const opaqueBilling=auditCloudflareBilling([{
  ServiceFamilyName:'Workers',ServiceName:'Workers Standard',ChargeDescription:'unknown',
  ConsumedQuantity:400,ConsumedUnit:'Milliseconds',
  ChargePeriodStart:'2026-11-17T00:00:00Z',ChargePeriodEnd:'2026-11-18T00:00:00Z',
  BillingPeriodStart:start,BillingCurrency:'USD',BilledCost:0
}],Date.parse('2026-11-18T12:00:00Z'));
const missing=reconcileWorkersAnalytics(opaqueBilling,valid);
assert.equal(missing.billableCertified,false);
assert.equal(missing.comparable,false);
assert.equal(missing.billingCpuMs,null);
assert.equal(cloudflareSeverity(opaqueBilling),'yellow','estimate must not clear billing unavailable alert');
const withGraph={...opaqueBilling,analytics:valid,reconciliation:missing,reconciliationVersion:2};
const text=cloudflareDigestLines(withGraph).join('\n');
assert.match(text,/WORKERS ANALYTICS GRAPHQL/);
assert.match(text,/CPU operacional estimada/);
assert.match(text,/NÃO substituem/);
const graphqlError=await fetchWorkersAnalyticsGraphQL({
  token:'x',account:'x',start,end:'2026-10-20T00:00:00Z',
  fetchImpl:async()=>({ok:true,json:async()=>({errors:[{message:'not permitted',extensions:{code:'FORBIDDEN'}}]})})
});
assert.equal(graphqlError.status,'unavailable');
assert.equal(graphqlError.reason,'graphql_query_errors');
assert.ok(!JSON.stringify(graphqlError).includes('not permitted'),'error text must not leak');
const invalid=await fetchWorkersAnalyticsGraphQL({
  token:'x',account:'x',start,end:'2026-10-20T00:00:00Z',
  fetchImpl:async()=>({ok:true,json:async()=>({data:{viewer:{accounts:[{
    workersInvocationsAdaptive:[{dimensions:{scriptName:'x'},sum:{requests:200,cpuTimeUs:null}}]
  }]}}})})
});
assert.equal(invalid.reason,'graphql_invalid_metric');
console.log('R38 E2 GraphQL reconciliation: PASS');
