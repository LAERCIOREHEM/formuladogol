// CF-COST-SHIELD R2 — Intelligent Cost Governance & Sports Continuity.
// Financial data are delayed observations, NOT a reliable per-request billing cap.
// Sports monitoring, scores, web push, factual FINAL and health remain independent.
// Paid AI has a separate atomic call quota, including during billing outages.
import { auditCloudflareBilling } from './cloudflare-billing-audit.js';
import { sendMail, mailConfig } from './mailer.js';

export const COST_SHIELD_VERSION = 2;
export const COST_SHIELD_POLICY = Object.freeze({
  dailyObserveUsd: 2,
  dailyPauseOptionalUsd: 5,
  dailyPauseSecondaryUsd: 10,
  monthlyProjectionWarningUsd: 50,
  staleAfterMs: 60 * 60_000,
  dailyRowsReadWarning: 5_000_000_000,
  dailyRowsWrittenWarning: 10_000_000
});
export const COST_SHIELD_PROVIDER_LIMITS = Object.freeze({
  gemini: Object.freeze({ daily: 80, hourly: 40, perEventDaily: 10 }),
  openai: Object.freeze({ daily: 32, hourly: 12, perEventDaily: 6 }),
  'workers-ai': Object.freeze({ daily: 120, hourly: 60, perEventDaily: 12 })
});
const SHIELD_NAME = 'cloudflare-account-global-cost-shield';
const json = (data, status=200) => new Response(JSON.stringify(data), {
  status, headers:{'content-type':'application/json','cache-control':'no-store'}
});
const number = value => value == null || value === '' ? null :
  (Number.isFinite(Number(value)) ? Number(value) : null);
const money = value => value == null ? null : Math.round(value * 10000) / 10000;
const positive = value => number(value) != null && Number(value) >= 0;
const iso = time => new Date(time).toISOString();
function brDay(now) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'})
    .format(new Date(now));
}
function brHour(now) {
  return new Intl.DateTimeFormat('en-GB',{timeZone:'America/Sao_Paulo',hour:'2-digit',hourCycle:'h23'})
    .format(new Date(now));
}
const MODES = Object.freeze(['unverified','normal','observe','optional_paused','secondary_paused']);
const severity = mode => ({unverified:0,normal:0,observe:1,optional_paused:2,secondary_paused:3})[mode] || 0;

/** Billed cost is cumulative and can lag. Never treat an unknown window as zero. */
export function evaluateSpend(samples, now=Date.now(), policy=COST_SHIELD_POLICY, reportedDailyUsd=null) {
  const current = Array.isArray(samples) ? samples.at(-1) : null;
  if (!current || !positive(current.costUsd))
    return {ok:false,reason:'billing_unavailable',hourlyUsd:null,dailyUsd:null,cycleUsd:null,monthlyProjectedUsd:null};
  const series=samples.filter(s=>s.cycleStart===current.cycleStart && s.ts<=now)
    .sort((a,b)=>a.ts-b.ts);
  function delta(ms) {
    const old=series.filter(s=>s.ts<=now-ms).at(-1);
    if (old) return Math.max(0,current.costUsd-old.costUsd);
    // For a cycle which started within the rolling period, all cycle spend
    // belongs to that period. For other cycles no pre-observation assumption.
    if (now-Date.parse(current.cycleStart)>=0 &&
        now-Date.parse(current.cycleStart)<=ms) return current.costUsd;
    const first=series[0];
    return first && now-first.ts<=ms ? Math.max(0,current.costUsd-first.costUsd) : null;
  }
  const hourly=delta(3_600_000), rolling=delta(86_400_000);
  const reported=positive(reportedDailyUsd) ? Number(reportedDailyUsd) : null;
  const daily=rolling==null?reported:reported==null?rolling:Math.max(rolling,reported);
  const elapsed=Math.max(1,(now-Date.parse(current.cycleStart))/86_400_000);
  const projected=Number.isFinite(elapsed)?money(current.costUsd/elapsed*30):null;
  const mode=daily!=null&&daily>=policy.dailyPauseSecondaryUsd?'secondary_paused':
    daily!=null&&daily>=policy.dailyPauseOptionalUsd?'optional_paused':
    daily!=null&&daily>=policy.dailyObserveUsd?'observe':'normal';
  return {ok:true,reason:mode,mode,hourlyUsd:money(hourly),dailyUsd:money(daily),
    cycleUsd:money(current.costUsd),monthlyProjectedUsd:projected,
    dailyCostBasis:reported!=null?'billing_charge_period_and_rolling_samples':'rolling_billing_samples'};
}

/** Best-effort calendar-day evidence; no zero-cost inference from missing rows. */
export function billingCalendarDayUsd(rows, now=Date.now(), cycleStart='') {
  const day=brDay(now), seen=new Set();let total=0,found=0;
  for (const row of Array.isArray(rows)?rows:[]) {
    if (cycleStart && row?.BillingPeriodStart !== cycleStart) continue;
    if (String(row?.BillingCurrency||'').toUpperCase()!=='USD') continue;
    const start=Date.parse(row?.ChargePeriodStart||'');
    if(!Number.isFinite(start)||brDay(start)!==day) continue;
    const cost=number(row?.BilledCost??row?.ContractedCost);
    if(cost==null||cost<0) continue;
    const key=JSON.stringify(row,Object.keys(row).sort());
    if(seen.has(key)) continue;
    seen.add(key);total+=cost;found+=1;
  }
  return found?money(total):null;
}

export function evaluateD1Rows(rows,policy=COST_SHIELD_POLICY) {
  if(!Array.isArray(rows)) return {ok:false,reason:'analytics_unavailable'};
  const total=rows.reduce((s,row)=>({
    read:s.read+Math.max(0,number(row?.sum?.rowsRead)||0),
    written:s.written+Math.max(0,number(row?.sum?.rowsWritten)||0)
  }),{read:0,written:0});
  return {ok:true,read:total.read,written:total.written,
    reason:total.read>=policy.dailyRowsReadWarning?'d1_read_anomaly':
      total.written>=policy.dailyRowsWrittenWarning?'d1_write_anomaly':null};
}

export function governanceDecision(state={}, now=Date.now(), policy=COST_SHIELD_POLICY) {
  const valid=number(state.lastSuccessAt)>0 && now-Number(state.lastSuccessAt)<=policy.staleAfterMs;
  const observed=valid?String(state.lastVerifiedMode||'normal'):'unverified';
  const d1Fresh=number(state.d1LastSuccessAt)>0 && now-Number(state.d1LastSuccessAt)<=policy.staleAfterMs;
  const d1Excess=d1Fresh&&(number(state.d1Read)>=policy.dailyRowsReadWarning ||
    number(state.d1Written)>=policy.dailyRowsWrittenWarning);
  const mode=d1Excess?'secondary_paused':MODES.includes(observed)?observed:'unverified';
  const billingVerified=valid;
  return {version:COST_SHIELD_VERSION,halted:false,mode,
    reason:d1Excess?'d1_anomaly':mode==='unverified'?(state.billingError||'billing_unavailable'):
      mode==='normal'?'within_budget':mode,
    billingVerified,costUnverified:!billingVerified,
    optionalAllowed:mode!=='optional_paused'&&mode!=='secondary_paused',
    secondaryAllowed:mode!=='secondary_paused',
    essentialSportsAllowed:true,
    dataAsOf:state.lastSuccessAt?iso(state.lastSuccessAt):null,
    lastCheckedAt:state.lastCheckedAt?iso(state.lastCheckedAt):null,
    lastSuccessAt:state.lastSuccessAt?iso(state.lastSuccessAt):null,
    hourlyUsd:state.hourlyUsd??null,dailyUsd:state.dailyUsd??null,
    cycleUsd:state.cycleUsd??null,monthlyProjectedUsd:state.monthlyProjectedUsd??null,
    d1Read:state.d1Read??null,d1Written:state.d1Written??null,
    cycleStart:state.cycleStart||null,billingError:state.billingError||'',
    dailyCostBasis:state.dailyCostBasis||null,
    providerLimits:COST_SHIELD_PROVIDER_LIMITS,
    // Older R1 halted latch is intentionally ignored (automatic migration).
    legacyLatchIgnored:state.halted===true};
}

export function getShieldStub(env) {
  if(!env?.COST_SHIELD)throw new Error('cost_shield_binding_missing');
  return env.COST_SHIELD.get(env.COST_SHIELD.idFromName(SHIELD_NAME));
}

export async function pollCostShield(env, now=Date.now(), fetcher=fetch) {
  let report={ok:false,reason:'missing_credentials',at:iso(now)};
  const account=String(env.AI_GATEWAY_ACCOUNT_ID||'').trim();
  const token=String(env.CLOUDFLARE_BILLING_READ_TOKEN||'').trim();
  if(account&&token){
    try{
      const r=await fetcher('https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(account)+'/billable-usage',{
        headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(8000)});
      const body=await r.json();
      if(!r.ok||body?.success!==true||!Array.isArray(body?.result))
        throw new Error('billing_http_'+r.status);
      const audit=auditCloudflareBilling(body.result,now);
      if(!audit.ok||!positive(audit.billedCost)||!audit.workers?.periodStart)
        throw new Error('billing_cycle_unavailable');
      if(String(audit.currency).toUpperCase()!=='USD')
        throw new Error('billing_currency_not_usd');
      report={ok:true,cycleStart:audit.workers.periodStart,costUsd:audit.billedCost,
        dailyUsd:billingCalendarDayUsd(body.result,now,audit.workers.periodStart),
        at:iso(now),source:'cloudflare_billable_usage'};
    }catch(error){report={ok:false,reason:String(error?.message||error).slice(0,90),at:iso(now)};}
  }
  let d1=null;
  const analyticsToken=String(env.CLOUDFLARE_ANALYTICS_READ_TOKEN||'').trim();
  if(account&&analyticsToken){
    try{
      const today=iso(now).slice(0,10);
      const query='query($accountTag:string!,$date:Date){viewer{accounts(filter:{accountTag:$accountTag}){d1AnalyticsAdaptiveGroups(limit:1000,filter:{date_geq:$date,date_leq:$date}){sum{rowsRead rowsWritten} dimensions{databaseId}}}}}';
      const r=await fetcher('https://api.cloudflare.com/client/v4/graphql',{
        method:'POST',headers:{authorization:'Bearer '+analyticsToken,'content-type':'application/json'},
        body:JSON.stringify({query,variables:{accountTag:account,date:today}}),
        signal:AbortSignal.timeout(8000)});
      const data=await r.json();
      const rows=data?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups;
      if(!r.ok||data.errors?.length||!Array.isArray(rows))throw new Error('d1_analytics_unavailable');
      d1=evaluateD1Rows(rows);
    }catch(error){d1={ok:false,reason:String(error?.message||error).slice(0,90)};}
  }
  try{
    const res=await getShieldStub(env).fetch('https://shield.internal/sample',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({report,d1,now})});
    if(!res.ok)throw new Error('state_write_failed_'+res.status);
    const result=await res.json();
    // One email for each worsening cost tier per Brazilian day. No email
    // for stale billing or $2 observation alone.
    if(result.justEscalated){
      console.error(JSON.stringify({type:'COST_SHIELD_R2_CONTAINMENT',mode:result.mode,at:iso(now)}));
      try{if(mailConfig(env).configured) await sendMail(env,{
        subject:'[CF-COST-SHIELD R2] Contenção seletiva — Cloudflare',
        body:['Custos Cloudflare: '+result.mode,
          'Últimas 24h USD: '+String(result.dailyUsd??'não verificado'),
          'Ciclo USD: '+String(result.cycleUsd??'não verificado'),
          'Serviços esportivos e notificações permanecem ativos.',
          'Tarefas opcionais: '+(result.optionalAllowed?'autorizadas':'pausadas'),
          'A retomada é automática após normalização.'].join('\n')
      });}catch(error){console.error('COST_SHIELD_EMAIL_FAILED:'+String(error?.message||error).slice(0,120));}
    }
    return result;
  }catch(error){
    console.error(JSON.stringify({type:'cost_shield_poll_error',reason:String(error?.message||error).slice(0,120)}));
    return governanceDecision({billingError:'coordinator_unavailable'},now);
  }
}

export async function readCostShield(env) {
  try{
    const response=await getShieldStub(env).fetch('https://shield.internal/status');
    if(!response.ok)throw new Error('read_failed_'+response.status);
    const value=await response.json();
    if(value?.version!==COST_SHIELD_VERSION)throw new Error('version_mismatch');
    return value;
  }catch{return governanceDecision({billingError:'coordinator_unavailable'});}
}

export async function reserveProviderCall(env,provider,eventId='',units=1) {
  try {
    const response=await getShieldStub(env).fetch('https://shield.internal/reserve',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({provider,eventId:String(eventId||'global').slice(0,128),
        units,now:Date.now()})
    });
    if(!response.ok)return {allowed:false,reason:'budget_coordinator_http_'+response.status};
    return await response.json();
  }catch{return {allowed:false,reason:'budget_coordinator_unavailable'};}
}

export class CostShieldState {
  constructor(state){this.state=state;}
  async fetch(request){
    const url=new URL(request.url),now=Date.now();
    const storage=this.state.storage;
    const saved=await storage.get('status')||{
      createdAt:now,halted:false,reason:'bootstrapping',samples:[],
      lastSuccessAt:0,lastCheckedAt:0,lastVerifiedMode:'normal'
    };
    if(url.pathname==='/status'&&request.method==='GET'){
      const status=governanceDecision(saved,now);
      const quota=await storage.get('quota:'+brDay(now))||{};
      return json({...status,providerUsage:Object.fromEntries(
        Object.entries(COST_SHIELD_PROVIDER_LIMITS).map(([name])=>
          [name,Number(quota?.[name]?.daily||0)]))});
    }
    if(url.pathname==='/sample'&&request.method==='POST'){
      const body=await request.json().catch(()=>null);
      if(!body||!Number.isFinite(body.now))return json({error:'invalid_sample'},400);
      const previous=governanceDecision(saved,body.now);
      const data={...saved,halted:false,lastCheckedAt:body.now};
      if(body.report?.ok&&positive(body.report.costUsd)&&body.report.cycleStart){
        if(data.cycleStart!==body.report.cycleStart)data.samples=[];
        data.cycleStart=body.report.cycleStart;
        data.samples=[...(data.samples||[]),{ts:body.now,cycleStart:data.cycleStart,costUsd:body.report.costUsd}]
          .filter(s=>body.now-s.ts<=50*3_600_000).slice(-650);
        const evald=evaluateSpend(data.samples,body.now,COST_SHIELD_POLICY,body.report.dailyUsd);
        data.lastSuccessAt=body.now;data.lastVerifiedMode=evald.mode;
        data.hourlyUsd=evald.hourlyUsd;data.dailyUsd=evald.dailyUsd;
        data.cycleUsd=evald.cycleUsd;data.monthlyProjectedUsd=evald.monthlyProjectedUsd;
        data.dailyCostBasis=evald.dailyCostBasis;data.billingError='';
      }else{
        data.billingError=String(body.report?.reason||'billing_unavailable').slice(0,90);
      }
      if(body.d1?.ok){
        data.d1Read=body.d1.read;data.d1Written=body.d1.written;
        data.d1LastSuccessAt=body.now;
      }
      const current=governanceDecision(data,body.now);
      const day=brDay(body.now);
      const previouslyAlerted=data.lastAlertDay===day?Number(data.lastAlertSeverity||0):0;
      const justEscalated=severity(current.mode)>=2 && severity(current.mode)>previouslyAlerted;
      if(justEscalated){
        data.lastAlertDay=day;data.lastAlertSeverity=severity(current.mode);
      }
      await storage.put('status',data);
      return json({...governanceDecision(data,body.now),justEscalated,
        previousMode:previous.mode});
    }
    if(url.pathname==='/reserve'&&request.method==='POST'){
      const body=await request.json().catch(()=>null);
      const provider=String(body?.provider||'');
      const limit=COST_SHIELD_PROVIDER_LIMITS[provider];
      const units=Number(body?.units||1);
      if(!limit||!Number.isInteger(units)||units<1||units>3)
        return json({allowed:false,reason:'invalid_budget_request'},400);
      const id=String(body?.eventId||'global').slice(0,128);
      const clock=Number.isFinite(body?.now)?Number(body.now):now;
      const policy=governanceDecision(saved,now);
      if(!policy.optionalAllowed)return json({allowed:false,reason:'optional_work_paused',mode:policy.mode});
      const key='quota:'+brDay(clock),hour=brHour(clock);
      const mutate=async db=>{
        const quota=await db.get(key)||{};
        const lane=quota[provider]||{daily:0,hours:{},events:{}};
        const daily=Number(lane.daily||0),hourly=Number(lane.hours?.[hour]||0);
        const eventDaily=Number(lane.events?.[id]||0);
        if(daily+units>limit.daily||hourly+units>limit.hourly||
          eventDaily+units>limit.perEventDaily)
          return {allowed:false,reason:'provider_call_quota',provider,daily,hourly,eventDaily,limit};
        quota[provider]={daily:daily+units,
          hours:{...lane.hours,[hour]:hourly+units},
          events:{...lane.events,[id]:eventDaily+units}};
        await db.put(key,quota);
        return {allowed:true,provider,remainingDaily:limit.daily-daily-units,
          remainingHourly:limit.hourly-hourly-units,
          remainingEventDaily:limit.perEventDaily-eventDaily-units};
      };
      const answer=typeof storage.transaction==='function'?
        await storage.transaction(mutate):await mutate(storage);
      return json(answer);
    }
    if(url.pathname==='/reset'&&request.method==='POST'){
      // R2 has no global latch. Keep old authenticated API non-destructive.
      return json({ok:true,automaticRecovery:true,...governanceDecision(saved,now)});
    }
    return json({error:'not_found'},404);
  }
}
