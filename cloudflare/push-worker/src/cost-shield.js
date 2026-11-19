import { auditCloudflareBilling } from './cloudflare-billing-audit.js';

export const COST_SHIELD_VERSION = 1;
export const COST_SHIELD_POLICY = Object.freeze({
  hourlyStopUsd: 2, dailyStopUsd: 5, cycleStopUsd: 10,
  staleAfterMs: 10 * 60_000, bootstrapGraceMs: 5 * 60_000,
  dailyRowsReadStop: 5_000_000_000, dailyRowsWrittenStop: 10_000_000
});
const SHIELD_NAME = 'cloudflare-account-global-cost-shield';
const json = (data, status=200) => new Response(JSON.stringify(data), {
  status, headers:{'content-type':'application/json','cache-control':'no-store'}
});
const n = v => Number.isFinite(Number(v)) ? Number(v) : null;
const positive = v => v != null && Number.isFinite(v) && v >= 0;
const iso = t => new Date(t).toISOString();

export function evaluateSpend(samples, now=Date.now(), policy=COST_SHIELD_POLICY) {
  const current=samples.at(-1);
  if(!current || !positive(current.costUsd))
    return {ok:false,reason:'billing_unavailable',hourlyUsd:null,dailyUsd:null,cycleUsd:null};
  const series=samples.filter(s=>s.cycleStart===current.cycleStart && s.ts<=now);
  const diff=(windowMs)=>{
    const older=series.filter(s=>s.ts<=now-windowMs).at(-1);
    if(!older)return null;
    return Math.max(0,current.costUsd-older.costUsd);
  };
  const hour=diff(3_600_000), day=diff(86_400_000);
  const reason=current.costUsd>=policy.cycleStopUsd?'cycle_limit':
    hour!==null&&hour>=policy.hourlyStopUsd?'hourly_limit':
    day!==null&&day>=policy.dailyStopUsd?'rolling_24h_limit':null;
  return {ok:true,reason,hourlyUsd:hour,dailyUsd:day,cycleUsd:current.costUsd};
}

export function evaluateD1Rows(rows, policy=COST_SHIELD_POLICY) {
  if(!Array.isArray(rows))return {ok:false,reason:'analytics_unavailable'};
  const total=rows.reduce((s,row)=>({
    read:s.read+Math.max(0,n(row?.sum?.rowsRead)||0),
    written:s.written+Math.max(0,n(row?.sum?.rowsWritten)||0)
  }),{read:0,written:0});
  return {ok:true,read:total.read,written:total.written,
    reason:total.read>=policy.dailyRowsReadStop?'d1_daily_rows_read':
      total.written>=policy.dailyRowsWrittenStop?'d1_daily_rows_written':null};
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
      if(!r.ok||body?.success!==true||!Array.isArray(body?.result))throw new Error('billing_http_'+r.status);
      const audit=auditCloudflareBilling(body.result,now);
      if(!audit.ok||!positive(audit.billedCost)||!audit.workers?.periodStart)
        throw new Error('billing_cycle_unavailable');
      report={ok:true,cycleStart:audit.workers.periodStart,costUsd:audit.billedCost,
        at:iso(now),source:'cloudflare_billable_usage'};
    }catch(e){report={ok:false,reason:String(e?.message||e).slice(0,90),at:iso(now)};}
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
    }catch(e){d1={ok:false,reason:String(e?.message||e).slice(0,90)};}
  }
  try{
    const res=await getShieldStub(env).fetch('https://shield.internal/sample',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({report,d1,now})});
    if(!res.ok)throw new Error('state_write_failed_'+res.status);
    return await res.json();
  }catch(e){console.error(JSON.stringify({type:'cost_shield_poll_error',reason:String(e?.message||e).slice(0,120)}));
    return {ok:false,halted:true,reason:'state_unavailable'};}
}

export async function readCostShield(env) {
  try{
    const r=await getShieldStub(env).fetch('https://shield.internal/status');
    if(!r.ok)throw new Error('read_failed');
    return await r.json();
  }catch{return {version:COST_SHIELD_VERSION,halted:true,reason:'state_unavailable'};}
}

export class CostShieldState {
  constructor(state){this.state=state;}
  async fetch(request){
    const url=new URL(request.url), now=Date.now();
    const saved=await this.state.storage.get('status')||{
      createdAt:now,halted:false,reason:'bootstrapping',samples:[],lastSuccessAt:0,lastCheckedAt:0
    };
    const publicStatus=s=>{
      const stale=!s.lastSuccessAt&&now-s.createdAt>=COST_SHIELD_POLICY.bootstrapGraceMs ||
        s.lastSuccessAt>0&&now-s.lastSuccessAt>COST_SHIELD_POLICY.staleAfterMs;
      return {version:COST_SHIELD_VERSION,halted:Boolean(s.halted||stale),
        reason:s.halted?s.reason:stale?'billing_monitor_stale':s.reason||'ok',
        lastCheckedAt:s.lastCheckedAt?iso(s.lastCheckedAt):null,
        lastSuccessAt:s.lastSuccessAt?iso(s.lastSuccessAt):null,
        hourlyUsd:s.hourlyUsd??null,dailyUsd:s.dailyUsd??null,cycleUsd:s.cycleUsd??null,
        d1Read:s.d1Read??null,d1Written:s.d1Written??null,
        cycleStart:s.cycleStart||null};
    };
    if(url.pathname==='/status'&&request.method==='GET')return json(publicStatus(saved));
    if(url.pathname==='/sample'&&request.method==='POST'){
      const body=await request.json().catch(()=>null);
      if(!body||!Number.isFinite(body.now))return json({error:'invalid_sample'},400);
      const data={...saved,lastCheckedAt:body.now};
      if(body.report?.ok&&positive(body.report.costUsd)){
        if(data.cycleStart!==body.report.cycleStart)data.samples=[];
        data.cycleStart=body.report.cycleStart;
        data.samples.push({ts:body.now,cycleStart:data.cycleStart,costUsd:body.report.costUsd});
        data.samples=data.samples.filter(s=>body.now-s.ts<=50*3_600_000).slice(-650);
        const evald=evaluateSpend(data.samples,body.now);
        data.lastSuccessAt=body.now;data.hourlyUsd=evald.hourlyUsd;
        data.dailyUsd=evald.dailyUsd;data.cycleUsd=evald.cycleUsd;
        if(evald.reason){data.halted=true;data.reason=evald.reason;data.haltedAt=data.haltedAt||body.now;}
        else if(!data.halted)data.reason='ok';
      }else if(!data.halted)data.reason=body.report?.reason||'billing_unavailable';
      if(body.d1?.ok){
        data.d1Read=body.d1.read;data.d1Written=body.d1.written;
        if(body.d1.reason){data.halted=true;data.reason=body.d1.reason;data.haltedAt=data.haltedAt||body.now;}
      }
      await this.state.storage.put('status',data);
      return json(publicStatus(data));
    }
    if(url.pathname==='/reset'&&request.method==='POST'){
      // Reset requires authenticated outer Worker route and a new independent
      // explicit command. Never re-arm while the cycle limit remains exceeded.
      if(!saved.lastSuccessAt||now-saved.lastSuccessAt>COST_SHIELD_POLICY.staleAfterMs||
        (saved.cycleUsd??Infinity)>=COST_SHIELD_POLICY.cycleStopUsd)
        return json({ok:false,error:'cannot_reset_unverified_or_over_budget'},409);
      saved.halted=false;saved.reason='manual_reset';saved.haltedAt=null;
      await this.state.storage.put('status',saved);
      return json({ok:true,...publicStatus(saved)});
    }
    return json({error:'not_found'},404);
  }
}
