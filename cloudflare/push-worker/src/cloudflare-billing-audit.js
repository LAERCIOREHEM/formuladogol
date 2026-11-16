/* Fórmula do Gol — auditoria Cloudflare Billing v2, exclusivamente leitura.
   API V1 /billable-usage: uma linha por métrica e ChargePeriod, valores BilledCost
   não são o mesmo que CumulatedContractedCost. BillingPeriodEnd pode faltar.
   Esta fonte NÃO oferece discriminação de CPU por Worker individual. */
export const CF_WORKERS_CPU_INCLUDED_MS = 30_000_000;
export const CF_WORKERS_REQUESTS_INCLUDED = 10_000_000;
const CPU_OVERAGE_PER_MILLION_USD = 0.02;
const REQUEST_OVERAGE_PER_MILLION_USD = 0.30;
export const CF_BILLING_AUDIT_VERSION = 2;
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
function family(row) {
  const given=str(row.ServiceFamilyName||row.x_ProductFamilyName||'');
  const service=str(row.ServiceName);
  if(norm(given)==='workers' && service && norm(service)!=='workers_standard') return service;
  if (given) return given;
  if (/^Workers AI\b/i.test(service)) return 'Workers AI';
  if (/^Workers\b/i.test(service)) return 'Workers';
  return service || 'Sem categoria';
}
function workerMetric(row) {
  const fam=norm(row.ServiceFamilyName||row.x_ProductFamilyName);
  const service=norm(row.ServiceName);
  if (fam!=='workers' && service!=='workers_standard') return '';
  // Nunca confundir Workers AI, Workflows, Durables ou KV com Workers Standard.
  if (service && service!=='workers_standard') return '';
  const id=norm(row.x_BillableMetricId);
  if (id) {
    if (id==='workers_standard_cpu_time') return 'cpu';
    if (id==='workers_standard_requests') return 'requests';
    return '';
  }
  // V1 omite x_BillableMetricId: fallback limitado aos nomes literais oficiais.
  const name=norm(row.x_BillableMetricName || row.ChargeDescription);
  if (name==='workers_standard_cpu_time' || name==='workers_standard_cpu_time_daily_usage') return 'cpu';
  if (name==='workers_standard_requests' || name==='workers_standard_requests_daily_usage') return 'requests';
  // API V1 pode fornecer apenas ServiceName + ConsumedUnit, sem x_BillableMetricId.
  // Somente o produto exatamente Workers Standard entra neste fallback.
  if (service==='workers_standard' && (!name || name.startsWith('workers_standard_usage_measured_in_'))) {
    const unit=norm(row.ConsumedUnit);
    if (['milliseconds','millisecond','cpu_ms','ms','microseconds','nanoseconds','seconds'].includes(unit)) return 'cpu';
    if (['requests','request'].includes(unit)) return 'requests';
  }
  return '';
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
  const cycle=currentCycle(list,now);
  const base={
    auditVersion:CF_BILLING_AUDIT_VERSION,
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
    if(startRow!==start){base.excluded.otherCycle++;continue;}
    const chargeStart=validDate(row.ChargePeriodStart);
    const chargeEnd=validDate(row.ChargePeriodEnd);
    if(chargeStart==null||chargeStart<start||chargeStart>=end ||
       (chargeEnd!=null&&(chargeEnd<=chargeStart||chargeEnd>end+DAY))){
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
    const group=family(row),m=workerMetric(row),cost=asMoney(row);
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
      const amount=cpuMs(row.ConsumedQuantity,row.ConsumedUnit);
      if(amount==null){ambiguous=true;base.excluded.invalidQuantity++;continue;}
      cpu+=amount;nCpu++;latestCpu=Math.max(latestCpu,last);
      if(iso(chargeStart).slice(0,10)===brDate(now)){todayCpu+=amount;nTodayCpu++;}
      observedCpu=Math.max(observedCpu,last);
    }
    if(m==='requests') {
      const amount=requestCount(row.ConsumedQuantity,row.ConsumedUnit);
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
  };
  base.workers=workers;
  return base;
}

/** Compatibilidade com teste existente; novos consumidores devem ler audit. */
export function summarizeCloudflareWorkersUsage(rows=[],now=Date.now()) {
  return auditCloudflareBilling(rows,now).workers;
}
