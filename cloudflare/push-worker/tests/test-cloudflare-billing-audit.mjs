import assert from 'node:assert/strict';
import { auditCloudflareBilling, summarizeCloudflareWorkersUsage } from '../src/cloudflare-billing-audit.js';
import { cloudflareSeverity, cloudflareDigestLines } from '../src/health-monitor.js';

const NOW=Date.parse('2026-11-16T13:00:00Z');
const period='2026-10-19T00:00:00Z';
const old='2026-09-19T00:00:00Z';
const at='2026-11-15T00:00:00Z';
function row(metric,quantity,unit,opts={}) {
  return {
    ServiceFamilyName:'Workers',ServiceName:'Workers Standard',
    x_BillableMetricName:metric==='cpu'?'Workers Standard CPU Time':'Workers Standard Requests',
    x_BillableMetricId:metric==='cpu'?'workers_standard_cpu_time':'workers_standard_requests',
    ChargePeriodStart:at,ChargePeriodEnd:'2026-11-16T00:00:00Z',
    BillingPeriodStart:period,ConsumedQuantity:quantity,
    ConsumedUnit:unit,BillingCurrency:'USD',BilledCost:0,...opts
  };
}
const sample=[
  row('cpu',14_708_270,'Milliseconds'),
  row('requests',66_826,'Requests'),
  row('cpu',25_000_000,'Milliseconds',{BillingPeriodStart:old,ChargePeriodStart:'2026-10-02T00:00:00Z',ChargePeriodEnd:'2026-10-03T00:00:00Z'}),
  { ...row('cpu',8_000_000,'Milliseconds'),ServiceFamilyName:'Workers AI',
    ServiceName:'Workers AI',x_BillableMetricId:'workers_ai_cpu',
    BilledCost:12.3 },
  { ...row('cpu',7_500_000,'Milliseconds'),ServiceFamilyName:'R2',
    ServiceName:'R2 Storage',x_BillableMetricId:'r2_class_a',
    BilledCost:67.73 },
];
const result=auditCloudflareBilling(sample,NOW);
assert.equal(result.ok,true);
assert.equal(result.auditVersion,4);
assert.equal(result.workers.status,'verified');
assert.equal(result.workers.cpuMs,14_708_270,'CPU deve ignorar ciclos antigos e outros produtos');
assert.equal(result.workers.requests,66_826);
assert.equal(result.workers.cpuUsedPct,49.0276);
assert.equal(result.workers.periodStart,'2026-10-19T00:00:00.000Z');
assert.equal(result.workers.periodEnd,'2026-11-19T00:00:00.000Z');
assert.equal(result.workers.periodEndEstimated,true);
assert.equal(result.workers.todayCpuMs,null,'ausência de linha hoje não significa 0 CPU');
assert.equal(result.workers.todayRequests,null);
assert.equal(result.workers.dataAsOf,'2026-11-16T00:00:00.000Z');
assert.ok(result.workers.projectedCpuMs>result.workers.cpuMs);
assert.equal(result.workers.currentOverageUsd,0);
assert.equal(result.billedCost,80.03);
assert.equal(result.workersBilledCost,0);
assert.equal(result.products.find(x=>x.name==='R2').costUsd,67.73);
assert.equal(result.products.find(x=>x.name==='Workers AI').costUsd,12.3);
assert.equal(result.excluded.otherCycle,1);
assert.equal(cloudflareSeverity(result),'yellow','custo agregado elevado deve resultar em atenção, não falsa CPU RED');
const digest=cloudflareDigestLines(result).join('\n');
assert.match(digest,/CPU Workers Standard: 14.708.270 \/ 30.000.000 ms/);
assert.match(digest,/Custos variáveis registrados de toda a conta: USD 80.03/);
assert.match(digest,/Custo variável da família Workers: USD 0.00/);
assert.match(digest,/R2: USD 67.73/);
assert.match(digest,/Workers AI: USD 12.30/);
assert.match(digest,/sem medição publicada para hoje/);
assert.match(digest,/CPU por Worker individual: indisponível/);
assert.doesNotMatch(digest,/Hoje.*CPU 0 ms/);

const safe=auditCloudflareBilling(sample.slice(0,2),NOW);
assert.equal(safe.workers.status,'verified');
assert.equal(cloudflareSeverity(safe),'green');
const mismatch=auditCloudflareBilling([
  row('cpu',9_000_000,'Minutes'),row('requests',20,'Requests')
],NOW);
assert.equal(mismatch.workers.status,'unavailable');
assert.equal(mismatch.workers.cpuMs,null);
assert.equal(mismatch.workers.projectedCpuMs,null);
assert.equal(cloudflareSeverity(mismatch),'yellow');

// V1 sem x_BillableMetricId: unidade CPU válida apenas em Workers Standard.
const v1Legacy=auditCloudflareBilling([
  row('cpu',3100,'Milliseconds',{x_BillableMetricId:null,x_BillableMetricName:null,
    ChargeDescription:'Workers Standard usage measured in Milliseconds'}),
  row('requests',99,'Requests',{x_BillableMetricId:null,x_BillableMetricName:null,
    ChargeDescription:'Workers Standard usage measured in Requests'})
],NOW);
assert.equal(v1Legacy.workers.cpuMs,3100);
assert.equal(v1Legacy.workers.requests,99);
assert.equal(v1Legacy.workers.status,'verified');

const otherService=auditCloudflareBilling([
  { ...row('cpu',5_000_000,'Milliseconds'),ServiceName:'Workers AI',ServiceFamilyName:'Workers AI' },
  row('requests',10,'Requests')
],NOW);
assert.equal(otherService.workers.cpuMs,null);
assert.equal(cloudflareSeverity(otherService),'yellow');

const noCurrent=auditCloudflareBilling([
  row('cpu',5_000_000,'Milliseconds',{BillingPeriodStart:old,ChargePeriodStart:'2026-09-26T00:00:00Z',ChargePeriodEnd:'2026-09-27T00:00:00Z'})
],NOW);
assert.equal(noCurrent.ok,false);
assert.equal(noCurrent.workers.cpuMs,null);
assert.equal(cloudflareSeverity(noCurrent),'yellow');
assert.match(cloudflareDigestLines(noCurrent).join('\n'),/Sem dado mensal verificável/);

const partial=auditCloudflareBilling([
  row('cpu',100,'Milliseconds'),row('requests',100,'Requests'),
  row('cpu',1,'Milliseconds',{BillingPeriodStart:null}),
],NOW);
assert.equal(partial.workers.status,'partial');
assert.equal(cloudflareSeverity(partial),'yellow');
assert.equal(partial.excluded.missingCycle,1);

const duplicated=auditCloudflareBilling([
  row('cpu',100,'Milliseconds'),row('cpu',100,'Milliseconds'),row('requests',100,'Requests')
],NOW);
assert.equal(duplicated.workers.cpuMs,100);
assert.equal(duplicated.excluded.duplicateRows,1);
assert.equal(duplicated.workers.status,'partial');

const missingCurrency=auditCloudflareBilling([
  row('cpu',100,'Milliseconds',{BillingCurrency:null,BilledCost:10}),
  row('requests',100,'Requests',{BillingCurrency:null,BilledCost:10})
],NOW);
assert.equal(missingCurrency.billedCost,null);
assert.equal(missingCurrency.workers.cpuMs,100);
assert.equal(missingCurrency.workers.status,'verified','moeda ausente não invalida contagem CPU');
assert.equal(cloudflareSeverity(missingCurrency),'yellow','custo total inconclusivo não deve ficar verde');

const stale=auditCloudflareBilling([
  row('cpu',100,'Milliseconds',{ChargePeriodStart:'2026-10-20T00:00:00Z',ChargePeriodEnd:'2026-10-21T00:00:00Z'}),
  row('requests',100,'Requests',{ChargePeriodStart:'2026-10-20T00:00:00Z',ChargePeriodEnd:'2026-10-21T00:00:00Z'})
],NOW);
assert.equal(stale.workers.status,'stale');
assert.equal(stale.workers.projectedCpuMs,null);
assert.equal(cloudflareSeverity(stale),'yellow');

const distinctCycles=auditCloudflareBilling([
  row('cpu',500000,'Milliseconds'),
  row('requests',250,'Requests'),
  { ...row('cpu',10_000_000,'Milliseconds'),ServiceFamilyName:'R2',
    ServiceName:'R2 Storage',x_BillableMetricId:'r2_class_a',
    BillingPeriodStart:'2026-11-01T00:00:00Z',BilledCost:30 }
],NOW);
assert.equal(distinctCycles.workers.periodStart,'2026-10-19T00:00:00.000Z');
assert.equal(distinctCycles.workers.cpuMs,500000);
assert.equal(distinctCycles.workers.status,'verified');
assert.equal(distinctCycles.billedCost,null,'não conciliar custos de dois ciclos atuais diferentes');
assert.equal(cloudflareSeverity(distinctCycles),'yellow');
const anotherPeriod=auditCloudflareBilling([
  row('cpu',200,'Milliseconds',{BillingPeriodStart:'2026-11-01T00:00:00Z',
    ChargePeriodStart:'2026-11-15T00:00:00Z',ChargePeriodEnd:'2026-11-16T00:00:00Z'}),
  row('requests',100,'Requests',{BillingPeriodStart:'2026-11-01T00:00:00Z',
    ChargePeriodStart:'2026-11-15T00:00:00Z',ChargePeriodEnd:'2026-11-16T00:00:00Z'}),
  row('cpu',9000,'Milliseconds',{BillingPeriodStart:period})
],NOW);
assert.equal(anotherPeriod.workers.periodStart,'2026-11-01T00:00:00.000Z');
assert.equal(anotherPeriod.workers.cpuMs,200);
assert.equal(anotherPeriod.excluded.otherCycle,1);

// Regressão: produção V1 usa nomes de cobrança comerciais, não IDs técnicos.
const commercialRows=[
  {ServiceFamilyName:'Workers',ServiceName:'Workers CPU ms (first 30M are included)',
    ChargeDescription:'Workers CPU ms (first 30M are included)',
    ConsumedQuantity:1_500_000,ConsumedUnit:'Milliseconds',
    ChargePeriodStart:at,ChargePeriodEnd:'2026-11-16T00:00:00Z',
    BillingPeriodStart:period,BillingCurrency:'USD',BilledCost:0},
  {ServiceFamilyName:'Workers',ServiceName:'Workers Standard Requests (first 10M are included)',
    ChargeDescription:'Workers Standard Requests (first 10M are included)',
    ConsumedQuantity:25_000,ConsumedUnit:'Requests',
    ChargePeriodStart:at,ChargePeriodEnd:'2026-11-16T00:00:00Z',
    BillingPeriodStart:period,BillingCurrency:'USD',BilledCost:0}
];
const commercial=auditCloudflareBilling(commercialRows,NOW);
assert.equal(commercial.workers.status,'verified','rótulos comerciais devem fornecer métricas válidas');
assert.equal(commercial.workers.cpuMs,1_500_000);
assert.equal(commercial.workers.requests,25_000);
assert.equal(commercial.workersBilledCost,0);
assert.equal(cloudflareSeverity(commercial),'green');
const commercialWithD1=auditCloudflareBilling([
  ...commercialRows,
  {...commercialRows[0],ServiceFamilyName:'D1',ServiceName:'D1 Database',
    ChargeDescription:'D1 rows read',ConsumedQuantity:999_999_999,ConsumedUnit:'Requests',BilledCost:79.74}
],NOW);
assert.equal(commercialWithD1.workers.cpuMs,1_500_000,'D1 não deve contaminar CPU');
assert.equal(commercialWithD1.workers.requests,25_000,'D1 não deve contaminar requests');
assert.equal(commercialWithD1.billedCost,79.74);
assert.equal(cloudflareSeverity(commercialWithD1),'yellow','custo D1 acima de USD 50 continua em atenção');
const wrongUnit=auditCloudflareBilling([
  {...commercialRows[0],ConsumedUnit:'Requests'},
  commercialRows[1]
],NOW);
assert.equal(wrongUnit.workers.cpuMs,null);
assert.equal(cloudflareSeverity(wrongUnit),'yellow','não aceitar unidade inconsistente');
const contradictory=auditCloudflareBilling([
  {...commercialRows[0],x_BillableMetricName:'Workers Standard Requests'},
  commercialRows[1]
],NOW);
assert.equal(contradictory.workers.cpuMs,null,'campos contraditórios não são confiáveis');

// R38-E1: evidence-first diagnostics and recovery for optional V1 fields.
const recoveredWithoutService=auditCloudflareBilling([
  {...commercialRows[0],ServiceName:null,x_BillableMetricName:'Workers Standard CPU Time',
    ChargeDescription:'Workers CPU ms (first 30M are included)'},
  {...commercialRows[1],ServiceName:null,x_BillableMetricName:'Workers Standard Requests'}
],NOW);
assert.equal(recoveredWithoutService.auditVersion,4);
assert.equal(recoveredWithoutService.workers.status,'verified');
assert.equal(recoveredWithoutService.workers.cpuMs,1_500_000);
assert.equal(recoveredWithoutService.workers.requests,25_000);
assert.equal(recoveredWithoutService.metricDiagnostics.recognizedCpuRows,1);
assert.equal(recoveredWithoutService.metricDiagnostics.recognizedRequestRows,1);
assert.equal(recoveredWithoutService.metricDiagnostics.unrecognizedRows,0);
const opaqueWorkers=auditCloudflareBilling([
  {...commercialRows[0],ServiceName:'Workers Standard',ChargeDescription:'Workers Standard novel CPU metric',
    x_BillableMetricName:null,ConsumedUnit:'Milliseconds'},
  {...commercialRows[1],ServiceName:'Workers Standard',ChargeDescription:'Workers novel request class',
    x_BillableMetricName:null}
],NOW);
assert.equal(opaqueWorkers.workers.status,'unavailable');
assert.equal(opaqueWorkers.metricDiagnostics.candidateRows,2);
assert.equal(opaqueWorkers.metricDiagnostics.unrecognizedRows,2);
assert.equal(opaqueWorkers.metricDiagnostics.reasons.unrecognized_metric_label,2);
assert.equal(opaqueWorkers.metricDiagnostics.examples.length,2);
assert.ok(!JSON.stringify(opaqueWorkers.metricDiagnostics).includes('1_500_000'));
assert.match(cloudflareDigestLines(opaqueWorkers).join('\n'),/Diagnóstico Workers V1: 2 registro/);
assert.match(cloudflareDigestLines(opaqueWorkers).join('\n'),/unrecognized_metric_label/);
const rejectedOtherProducts=auditCloudflareBilling([
  ...commercialRows,
  {...commercialRows[0],ServiceFamilyName:'Workers AI',ServiceName:'Workers AI',
    x_BillableMetricName:'Workers Standard CPU Time',ConsumedQuantity:9999999}
],NOW);
assert.equal(rejectedOtherProducts.workers.cpuMs,1_500_000);
assert.equal(rejectedOtherProducts.metricDiagnostics.candidateRows,2);

// R38-V4: live Billing V1 has no ConsumedUnit and reports PricingUnit=Count.
// Recover ONLY the two explicitly named Workers Standard commercial units.
const commercialCountRows=commercialRows.map(r=>({
  ...r,ConsumedUnit:null,PricingUnit:'Count',
  x_BillableMetricName:r.ServiceName+' usage measured in Count'
}));
const recoveredCount=auditCloudflareBilling(commercialCountRows,NOW);
assert.equal(recoveredCount.auditVersion,4);
assert.equal(recoveredCount.workers.status,'verified');
assert.equal(recoveredCount.workers.cpuMs,1_500_000);
assert.equal(recoveredCount.workers.requests,25_000);
assert.equal(recoveredCount.metricDiagnostics.candidateRows,2);
assert.equal(recoveredCount.metricDiagnostics.inferredUnitRows,2);
assert.equal(cloudflareSeverity(recoveredCount),'green');
assert.match(cloudflareDigestLines(recoveredCount).join('\\n'),/Recuperação V1: 2 unidade/);
const countFour=auditCloudflareBilling([
  ...commercialCountRows,
  ...commercialCountRows.map(r=>({
    ...r,ChargePeriodStart:'2026-11-14T00:00:00Z',
    ChargePeriodEnd:'2026-11-15T00:00:00Z'
  }))
],NOW);
assert.equal(countFour.metricDiagnostics.candidateRows,4);
assert.equal(countFour.metricDiagnostics.inferredUnitRows,4);
assert.equal(countFour.workers.cpuMs,3_000_000);
assert.equal(countFour.workers.requests,50_000);
assert.equal(countFour.workers.status,'verified');
for(const first of [
  {...commercialCountRows[0],PricingUnit:null},
  {...commercialCountRows[0],PricingUnit:'Seconds'},
  {...commercialCountRows[0],ServiceName:'Workers Standard'},
  {...commercialCountRows[0],ChargeDescription:'Workers Standard Requests'},
  {...commercialCountRows[0],x_BillableMetricName:'Workers Standard Requests'},
  {...commercialCountRows[0],ConsumedUnit:'Count'}
]) {
  const invalid=auditCloudflareBilling([first,commercialCountRows[1]],NOW);
  assert.equal(invalid.workers.status,'unavailable','unidade ambígua nunca certifica CPU');
  assert.equal(invalid.workers.cpuMs,null);
  assert.equal(cloudflareSeverity(invalid),'yellow');
}
const unrelatedCount=auditCloudflareBilling([
  {...commercialCountRows[0],ServiceFamilyName:'Workers AI'},
  commercialCountRows[1]
],NOW);
assert.equal(unrelatedCount.workers.cpuMs,null,'Workers AI não pode contaminar métricas Workers Standard');
assert.equal(cloudflareSeverity(unrelatedCount),'yellow');

const testFacade=summarizeCloudflareWorkersUsage(sample.slice(0,2),NOW);
assert.equal(testFacade.cpuMs,14_708_270);
assert.equal(testFacade.status,'verified');
console.log('HOTFIX Cloudflare Billing: ciclos, CPU, custos, alertas, dados parciais, projeções e fonte: PASS');
