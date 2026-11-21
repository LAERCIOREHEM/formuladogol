/* Fórmula do Gol — auditoria Cloudflare Billing v2, exclusivamente leitura.
   API V1 /billable-usage: uma linha por métrica e ChargePeriod, valores BilledCost
   não são o mesmo que CumulatedContractedCost. BillingPeriodEnd pode faltar.
   Esta fonte NÃO oferece discriminação de CPU por Worker individual. */
export const CF_WORKERS_CPU_INCLUDED_MS = 30_000_000;
export const CF_WORKERS_REQUESTS_INCLUDED = 10_000_000;
const CPU_OVERAGE_PER_MILLION_USD = 0.02;
const REQUEST_OVERAGE_PER_MILLION_USD = 0.30;
export const CF_BILLING_AUDIT_VERSION = 4;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function str(x) { return String(x ?? '').trim(); }
function n(x) { const v = Number(x); return Number.isFinite(v) ? v : null; }
function round(x, digits=3) { return x==null ? null : Number(x.toFixed(digits)); }
function norm(x) { return str(x).toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,''); }
function validDate(x) { const ms=Date.parse(str(x)); return Number.isFinite(ms) ? ms : null; }
function iso(ms) { return new Date(ms).toISOString(); }
function pct(x,total) { return x == null ? null : round(100*x/total,4); }
function asMoney(row) {
  const v=row.BilledCost ?? row.ContractedCost;
  return v == null ? null : n(v);
}
function nextMonthUtc(start) {
  const d = new Date(start);
  const y=d.getUTCFullYear(),m=d.getUTCMonth()+1,day=d.getUTCDate();
  const lastDay=new Date(Date.UTC(y,m+1,0)).getUTCDate();
  return Date.UTC(y,m,Math.min(day,lastDay),d.getUTCHours(),d.getUTCMinutes(),d.getUTCSeconds());
}
// Billable Usage V1 identifica algumas métricas pelo nome comercial de cobrança,
// sem ServiceName='Workers Standard' ou x_BillableMetricId. Aceitar apenas
// rótulos conhecidos e unidades compatíveis; nunca classificar produtos adjacentes.
const V1_CPU_LABELS = new Set([
  'workers_cpu_ms_first_30m_are_included',
  'workers_standard_cpu_time',
  'workers_standard_cpu_time_daily_usage',
  'workers_standard_usage_measured_in_milliseconds',
  'workers_standard_usage_measured_in_ms',
]);
const V1_REQUEST_LABELS = new Set([
  'workers_standard_requests_first_10m_are_included',
  'workers_standard_requests',
  'workers_standard_requests_daily_usage',
  'workers_standard_usage_measured_in_requests',
  'workers_standard_usage_measured_in_count',
]);
function metricLabelKind(value) {
  const name=norm(value);
  if(V1_CPU_LABELS.has(name)) return 'cpu';
  if(V1_REQUEST_LABELS.has(name)) return 'requests';
  return '';
}
function family(row) {
  const given=str(row.ServiceFamilyName||row.x_ProductFamilyName||'');
  const service=str(row.ServiceName);
  if(norm(given)==='workers' && service && norm(service)!=='workers_standard' &&
    !metricLabelKind(service)) return service;
  if (given) return given;
  if (metricLabelKind(service)||norm(service)==='workers_standard') return 'Workers';
  if (/^Workers AI\\b/i.test(service)) return 'Workers AI';
  if (/^Workers\\b/i.test(service)) return 'Workers';
  return service || 'Sem categoria';
}
// Cloudflare Billable Usage V1 sometimes omits ConsumedUnit and uses PricingUnit
// "Count" for both known commercial metrics. Recover the unit only when the
// exact Workers label explicitly names CPU milliseconds or request counts.
// Never use PricingUnit=Count alone to infer CPU units.
function resolveWorkersUnit(row,kind) {
  const consumed=norm(row.ConsumedUnit);
  if(consumed) return {unit:consumed,inferred:false};
  const service=norm(row.ServiceName);
  const fam=norm(row.ServiceFamilyName||row.x_ProductFamilyName);
  if(fam!=='workers'||norm(row.PricingUnit)!=='count')
    return {unit:'',inferred:false};
  const known={
    workers_cpu_ms_first_30m_are_included:'milliseconds',
    workers_standard_requests_first_10m_are_included:'count',
  };
  const expected=kind==='cpu'?'milliseconds':kind==='requests'?'count':'';
  if(!expected||known[service]!==expected) return {unit:'',inferred:false};
  for(const raw of [row.ChargeDescription,row.x_BillableMetricName]) {
    const label=norm(raw);
    if(label&&label!==service&&label!==service+'_usage_measured_in_count'&&
       metricLabelKind(raw)!==kind) return {unit:'',inferred:false};
  }
  return {unit:expected,inferred:true};
}
// Closed classification: recognized semantic label plus compatible measured unit.
function workerMetricAssessment(row) {
  const fam=norm(row.ServiceFamilyName||row.x_ProductFamilyName);
  const service=norm(row.ServiceName);
  const labels=[row.x_BillableMetricName,row.ChargeDescription,row.ServiceName]
    .map(metricLabelKind).filter(Boolean);
  const id=norm(row.x_BillableMetricId);
  const recognizedId=id==='workers_standard_cpu_time'?'cpu':
    id==='workers_standard_requests'?'requests':'';
  const standardFamily=fam===''||fam==='workers';
  const excludedService=/^(workers_ai|durable_objects|d1|r2|queues|worker_build|workers_kv|workflows)(_|$)/.test(service);
  if(!standardFamily||excludedService) return {kind:'',reason:'outside_workers_standard'};
  if(id&&!recognizedId) return {kind:'',reason:'unknown_metric_id'};
  if(new Set(labels).size>1||recognizedId&&labels.length&&labels.some(x=>x!==recognizedId))
    return {kind:'',reason:'conflicting_metric_fields'};
  const kind=recognizedId||labels[0]||'';
  if(!kind) return {kind:'',reason:'unrecognized_metric_label'};
  const resolvedUnit=resolveWorkersUnit(row,kind);
  const unit=resolvedUnit.unit;
  const cpuUnits=['milliseconds','millisecond','cpu_ms','ms','microseconds',
    'microsecond','nanoseconds','nanosecond','seconds','second'];
  const reqUnits=['requests','request','count'];
  if(kind==='cpu'&&!cpuUnits.includes(unit)||kind==='requests'&&!reqUnits.includes(unit))
    return {kind:'',reason:'unsupported_consumed_unit'};
  return {kind,reason:'recognized',unit,inferredUnit:resolvedUnit.inferred};
}
function workerMetric(row) { return workerMetricAssessment(row).kind; }
function isWorkersBillingRow(row) {
  const fam=norm(row.ServiceFamilyName||row.x_ProductFamilyName);
  const service=norm(row.ServiceName);
  if(fam&&fam!=='workers') return false;
  if(/^(workers_ai|durable_objects|d1|r2|queues|worker_build|workers_kv|workflows)(_|$)/.test(service)) return false;
  return fam==='workers'||service==='workers_standard'||
    metricLabelKind(row.ServiceName)!==''||metricLabelKind(row.ChargeDescription)!=='';
}
// Structural only; do not publish account IDs, amounts, quantities or full API rows.
function publicMetricDescriptor(row,reason) {
  const clean=x=>str(x).slice(0,96);
  return {
    reason,
    serviceFamily:clean(row.ServiceFamilyName||row.x_ProductFamilyName),
    serviceName:clean(row.ServiceName),
    metricId:clean(row.x_BillableMetricId),
    metricName:clean(row.x_BillableMetricName),
    chargeDescription:clean(row.ChargeDescription),
    consumedUnit:clean(row.ConsumedUnit),
    pricingUnit:clean(row.PricingUnit),
    quantityPresent:row.ConsumedQuantity!=null,
  };
}
function cpuMs(raw,unitRaw) {
  const qty=n(raw);
  if (qty===null || qty<0) return null;
  const unit=norm(unitRaw);
  if (unit==='milliseconds'||unit==='millisecond'||unit==='ms'||unit==='cpu_ms') return qty;
  if (unit==='microseconds'||unit==='microsecond') return qty/1000;
  if (unit==='nanoseconds'||unit==='nanosecond') return qty/1e6;
  if (unit==='seconds'||unit==='second') return qty*1000;
  // Unidades desconhecidas NÃO são presumidas como milissegundos.
  return null;
}
function requestCount(raw,unitRaw) {
  const qty=n(raw),unit=norm(unitRaw);
  return qty!=null&&qty>=0&&(unit==='requests'||unit==='request'||unit==='count') ? qty : null;
}
function brDate(ms) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));
}
function currentCycle(rows,now) {
  const anchors=[...new Set(rows.map(r=>validDate(r.BillingPeriodStart))
    .filter(ms=>ms!=null&&ms<=now))].sort((a,b)=>b-a);
  for(const start of anchors) {
    const end=nextMonthUtc(start);
    if(now<end) return {start,end};
  }
  return null;
}

/** Sumarização verificável: uma única franquia por ciclo, métricas estritas,
 *  custos por produto e visibilidade explícita de lacunas. */
export function auditCloudflareBilling(rows=[],now=Date.now()) {
  const list=Array.isArray(rows)?rows:[];
  const workersOnly=list.filter(isWorkersBillingRow);
  // A franquia é do Workers Standard: produtos com outro aniversário
  // de faturamento não podem determinar o denominador da CPU.
  const cycle=currentCycle(workersOnly,now)||currentCycle(list,now);
  const base={
    auditVersion:CF_BILLING_AUDIT_VERSION,
    metricDiagnostics:{candidateRows:0,recognizedCpuRows:0,recognizedRequestRows:0,
      inferredUnitRows:0,unrecognizedRows:0,reasons:{},examples:[],source:'billing-v1',schemaVersion:1},
    source:'Cloudflare Billable Usage v1 (conta, agregado por produto)',
    configured:true,ok:!!cycle,at:iso(now),
    currency:null,billedCost:null,workersBilledCost:null,
    products:[],rowCount:list.length,inCycleRows:0,
    excluded:{otherCycle:0,missingCycle:0,invalidChargePeriod:0,duplicateRows:0,invalidQuantity:0,missingCost:0,missingCurrency:0,mixedCurrency:0},
    workers:null,
  };
  if(!cycle) {
    base.reason='no_current_billing_cycle';
    base.workers={
      metricDiagnostics:base.metricDiagnostics,
      status:'unavailable',reason:'no_current_billing_cycle',
      cpuIncludedMs:CF_WORKERS_CPU_INCLUDED_MS,requestsIncluded:CF_WORKERS_REQUESTS_INCLUDED,
      cpuMs:null,requests:null,todayCpuMs:null,todayRequests:null,
      projectedCpuMs:null,projectedRequests:null,
      cpuUsedPct:null,requestUsedPct:null,
      currentOverageUsd:null,projectedOverageUsd:null,
      perWorker:{available:false,reason:'Billing API sem desagregação por Worker; requer Analytics Read.'}
    };
    return base;
  }
  const {start,end}=cycle;
  let maxEnd=0,latestCpu=0,latestReq=0,observedCpu=0,observedReq=0;
  let cpu=0,requests=0,todayCpu=0,todayReq=0;
  let nCpu=0,nReq=0,nTodayCpu=0,nTodayReq=0;
  let total=0,workerCost=0,missingCost=false,costUncertain=false,unknownCostWorkers=false;
  const families=new Map(),currencies=new Set(),seen=new Set();
  let ambiguous=false;
  for(const row of list) {
    const startRow=validDate(row.BillingPeriodStart);
    if(startRow==null){base.excluded.missingCycle++;costUncertain=true;
      if(workerMetric(row)||norm(row.ServiceName)==='workers_standard') ambiguous=true;
      continue;}
    if(startRow!==start) {
      base.excluded.otherCycle++;
      if(startRow<=now && now<nextMonthUtc(startRow)) costUncertain=true;
      continue;
    }
    const chargeStart=validDate(row.ChargePeriodStart);
    const chargeEnd=validDate(row.ChargePeriodEnd);
    if(chargeStart==null||chargeStart<start||chargeStart>=end ||
       (chargeEnd!=null&&(chargeEnd<=chargeStart||chargeEnd>end))){
      base.excluded.invalidChargePeriod++;costUncertain=true;
      if(workerMetric(row)||norm(row.ServiceName)==='workers_standard') ambiguous=true;
      continue;
    }
    const signature=JSON.stringify(row,Object.keys(row).sort());
    if(seen.has(signature)){base.excluded.duplicateRows++;costUncertain=true;
      if(workerMetric(row)||norm(row.ServiceName)==='workers_standard') ambiguous=true;
      continue;}
    seen.add(signature);
    base.inCycleRows++;
    const last=chargeEnd??Math.min(now,chargeStart+DAY);
    maxEnd=Math.max(maxEnd,last);
    const group=family(row),assessment=workerMetricAssessment(row),m=assessment.kind,cost=asMoney(row);
    if(isWorkersBillingRow(row)) {
      const diag=base.metricDiagnostics;
      diag.candidateRows++;
      if(m==='cpu') diag.recognizedCpuRows++;
      else if(m==='requests') diag.recognizedRequestRows++;
      if(m&&assessment.inferredUnit) diag.inferredUnitRows++;
      else {
        diag.unrecognizedRows++;
        diag.reasons[assessment.reason]=(diag.reasons[assessment.reason]||0)+1;
        if(diag.examples.length<6) diag.examples.push(publicMetricDescriptor(row,assessment.reason));
      }
    }
    const curr=str(row.BillingCurrency);
    if(curr) currencies.add(curr);
    else {missingCost=true;base.excluded.missingCurrency++;}
    const existing=families.get(group)||{name:group,costUsd:0,rows:0,costKnown:true};
    existing.rows++;
    if(cost==null) {existing.costKnown=false;missingCost=true;base.excluded.missingCost++;}
    else existing.costUsd+=cost;
    families.set(group,existing);
    if(cost!=null) total+=cost;
    if(group==='Workers'){
      if(cost!=null) workerCost+=cost;
      else unknownCostWorkers=true;
    }
    if(m==='cpu') {
      const amount=cpuMs(row.ConsumedQuantity,assessment.unit);
      if(amount==null){ambiguous=true;base.excluded.invalidQuantity++;continue;}
      cpu+=amount;nCpu++;latestCpu=Math.max(latestCpu,last);
      if(iso(chargeStart).slice(0,10)===brDate(now)){todayCpu+=amount;nTodayCpu++;}
      observedCpu=Math.max(observedCpu,last);
    }
    if(m==='requests') {
      const amount=requestCount(row.ConsumedQuantity,assessment.unit);
      if(amount==null){ambiguous=true;base.excluded.invalidQuantity++;continue;}
      requests+=amount;nReq++;latestReq=Math.max(latestReq,last);
      if(iso(chargeStart).slice(0,10)===brDate(now)){todayReq+=amount;nTodayReq++;}
      observedReq=Math.max(observedReq,last);
    }
  }
  if(currencies.size>1){base.excluded.mixedCurrency=currencies.size;missingCost=true;ambiguous=true;}
  base.currency=currencies.size===1?[...currencies][0]:null;
  base.billedCost=missingCost||costUncertain||currencies.size!==1?null:round(total,6);
  base.workersBilledCost=unknownCostWorkers||currencies.size!==1?null:round(workerCost,6);
  base.products=[...families.values()].map(v=>({
    name:v.name,rows:v.rows,
    costUsd:v.costKnown&&currencies.size===1?round(v.costUsd,6):null
  })).sort((a,b)=>(b.costUsd??-Infinity)-(a.costUsd??-Infinity)||a.name.localeCompare(b.name));
  const staleMs=Math.max(0,now-Math.min(latestCpu||0,latestReq||0));
  const missingMetrics=nCpu===0||nReq===0;
  const incomplete=ambiguous||missingMetrics||base.inCycleRows===0;
  const stale=staleMs>72*HOUR;
  const status=missingMetrics?'unavailable':incomplete?'partial':stale?'stale':'verified';
  const cpuVal=nCpu?cpu:null,requestVal=nReq?requests:null;
  // A extrapolação usa a data da última medição, nunca o relógio puro
  // (billing é assíncrono e pode atrasar 24-48 horas).
  function projection(value,lastMeasured) {
    if(value==null||!lastMeasured||incomplete||stale) return null;
    const elapsed=Math.min(lastMeasured,end)-start;
    return elapsed>0?round(value*(end-start)/elapsed,3):null;
  }
  const projectedCpu=projection(cpuVal,latestCpu);
  const projectedReq=projection(requestVal,latestReq);
  const overage=(a,b)=>{
    if(a==null||b==null) return null;
    return round(Math.max(0,a-CF_WORKERS_CPU_INCLUDED_MS)/1e6*CPU_OVERAGE_PER_MILLION_USD+
      Math.max(0,b-CF_WORKERS_REQUESTS_INCLUDED)/1e6*REQUEST_OVERAGE_PER_MILLION_USD,6);
  };
  const workers={
    status,reason:status==='verified'?'ok':missingMetrics?'missing_workers_standard_metrics':incomplete?'incomplete_billing_rows':'billing_data_stale',
    periodStart:iso(start),periodEnd:iso(end),periodEndEstimated:true, // fim derivado: API V1 não garante BillingPeriodEnd
    dataAsOf:maxEnd?iso(Math.min(maxEnd,now)):null,
    latestCpuAt:latestCpu?iso(Math.min(latestCpu,now)):null,
    latestRequestsAt:latestReq?iso(Math.min(latestReq,now)):null,
    dataLagHours:latestCpu&&latestReq?round(staleMs/HOUR,1):null,
    cpuMs:cpuVal==null?null:round(cpuVal),cpuIncludedMs:CF_WORKERS_CPU_INCLUDED_MS,
    cpuUsedPct:pct(cpuVal,CF_WORKERS_CPU_INCLUDED_MS),
    cpuRemainingPct:cpuVal==null?null:round(Math.max(0,100-pct(cpuVal,CF_WORKERS_CPU_INCLUDED_MS)),4),
    requests:requestVal==null?null:round(requestVal),requestsIncluded:CF_WORKERS_REQUESTS_INCLUDED,
    requestUsedPct:pct(requestVal,CF_WORKERS_REQUESTS_INCLUDED),
    requestRemainingPct:requestVal==null?null:round(Math.max(0,100-pct(requestVal,CF_WORKERS_REQUESTS_INCLUDED)),4),
    today:brDate(now),todayCpuMs:nTodayCpu?round(todayCpu):null,
    todayRequests:nTodayReq?round(todayReq):null,
    projectedCpuMs:projectedCpu,projectedCpuPct:pct(projectedCpu,CF_WORKERS_CPU_INCLUDED_MS),
    projectedRequests:projectedReq,projectedRequestPct:pct(projectedReq,CF_WORKERS_REQUESTS_INCLUDED),
    currentOverageUsd:overage(cpuVal,requestVal),
    projectedOverageUsd:overage(projectedCpu,projectedReq),
    billedCost:base.workersBilledCost,
    rowCount:{cpu:nCpu,requests:nReq},
    perWorker:{available:false,reason:'Billable Usage oferece agregado por produto, não por script; Analytics Read não configurado.'},
    metricDiagnostics:base.metricDiagnostics,
  };
  base.workers=workers;
  return base;
}

/** Compatibilidade com teste existente; novos consumidores devem ler audit. */
export function summarizeCloudflareWorkersUsage(rows=[],now=Date.now()) {
  return auditCloudflareBilling(rows,now).workers;
}
