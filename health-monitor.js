import { sendMail, mailConfig, maskAddress } from './mailer.js';
import { aiUsageSummary, providerUsageSummary } from './ai-usage.js';

const SITE = 'https://formuladogol.com.br';
const ORCH = 'https://orchestrator.formuladogol.com.br';
const SNAPSHOT_TTL_MS = 5 * 60_000;
const DAILY_HOUR_BRT = 8;
const DAILY_RECOVERY_END_HOUR_BRT = 12; // exclusivo: recupera até 11:59 BRT
const DAILY_RETRY_MS = 15 * 60_000;
const CF_BILLING_CACHE_MS = 60 * 60_000;
const CF_WORKERS_CPU_INCLUDED_MS = 30_000_000;
const CF_WORKERS_REQUESTS_INCLUDED = 10_000_000;
const CF_CPU_OVERAGE_PER_MILLION_USD = 0.02;
const CF_REQUEST_OVERAGE_PER_MILLION_USD = 0.30;
const HEALTH_POLICY_VERSION = 4;

function text(v) { return String(v ?? '').trim(); }
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function iso(ms = Date.now()) { return new Date(ms).toISOString(); }
function safeJson(s, f = null) { try { return JSON.parse(s); } catch (_) { return f; } }
function clamp(v,min,max){ return Math.min(max,Math.max(min,v)); }
function pct(v,total){ return total>0?(n(v)/n(total))*100:0; }
function fmtNum(v){ return new Intl.NumberFormat('pt-BR',{maximumFractionDigits:0}).format(n(v)); }
function fmtPct(v){ return `${n(v).toFixed(2).replace('.',',')}%`; }
function fmtUsd(v){ return `US$ ${n(v).toFixed(2)}`; }
function brParts(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone:'America/Sao_Paulo', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(new Date(now));
  const g = (t) => parts.find((p) => p.type === t)?.value || '';
  return { date:`${g('year')}-${g('month')}-${g('day')}`, hour:Number(g('hour')), minute:Number(g('minute')) };
}
function fmtDate(v) {
  const ms = Date.parse(text(v)); if (!Number.isFinite(ms)) return text(v) || '—';
  return new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}).format(new Date(ms));
}
function fmtDateOnly(v){
  const raw=text(v); const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(raw); if(!m) return raw||'—';
  return `${m[3]}/${m[2]}/${m[1]}`;
}
function dateOnly(v){ return (/^(\d{4}-\d{2}-\d{2})/.exec(text(v))||[])[1]||''; }
async function metaGet(env,key){ const r=await env.DB.prepare('SELECT value FROM health_monitor_meta WHERE key=?').bind(key).first(); return text(r?.value); }
async function metaPut(env,key,value){ await env.DB.prepare(`INSERT INTO health_monitor_meta(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(key,String(value ?? '')).run(); }
async function fetchJson(url, timeout=10000) {
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),timeout);
  try { const r=await fetch(url,{cache:'no-store',signal:c.signal}); const body=await r.json().catch(()=>null); return {ok:r.ok,status:r.status,body}; }
  catch(e){ return {ok:false,status:0,error:text(e?.message||e)}; } finally { clearTimeout(t); }
}

function workersMetricKind(row={}){
  const family=[row?.ServiceName,row?.ServiceFamilyName,row?.x_ProductFamilyName,row?.x_ProductCategoryName].map(text).join(' ').toLowerCase();
  const metric=[row?.x_BillableMetricId,row?.x_BillableMetricName,row?.ChargeDescription,row?.ConsumedUnit,row?.PricingUnit].map(text).join(' ').toLowerCase();
  if(!family.includes('worker')&&!metric.includes('worker')) return '';
  if(metric.includes('request')) return 'requests';
  if(metric.includes('cpu')) return 'cpu';
  const unit=text(row?.ConsumedUnit).toLowerCase();
  if(/millisecond|microsecond|nanosecond|cpu.?ms|\bms\b|second|minute|hour/.test(unit)) return 'cpu';
  return '';
}
function cpuToMs(value,unitRaw=''){
  const valueN=n(value); const unit=text(unitRaw).toLowerCase();
  if(unit.includes('nanosecond')) return valueN/1_000_000;
  if(unit.includes('microsecond')) return valueN/1_000;
  if(unit.includes('millisecond')||unit.includes('cpu-ms')||unit.includes('cpu ms')||unit==='ms') return valueN;
  if(unit.includes('minute')) return valueN*60_000;
  if(unit.includes('hour')) return valueN*3_600_000;
  if(unit.includes('second')) return valueN*1_000;
  // O medidor Workers Standard CPU é precificado em CPU-ms. Se a API omitir
  // a unidade, manter a quantidade como ms é a interpretação conservadora.
  return valueN;
}
function linearProjection(value,startRaw,endRaw,now=Date.now()){
  const start=Date.parse(text(startRaw)); const end=Date.parse(text(endRaw));
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||now<=start) return null;
  const periodDays=(end-start)/86_400_000;
  const elapsedDays=Math.max(1,(Math.min(now,end)-start)/86_400_000);
  return n(value)*(periodDays/elapsedDays);
}

export function summarizeCloudflareWorkersUsage(rows=[], now=Date.now()){
  const list=Array.isArray(rows)?rows:[]; const today=brParts(now).date;
  let cpuMs=0, requests=0, todayCpuMs=0, todayRequests=0, billedCost=0;
  let periodStart='', periodEnd='';
  for(const row of list){
    const kind=workersMetricKind(row); if(!kind) continue;
    billedCost+=n(row?.BilledCost);
    const start=text(row?.BillingPeriodStart); const end=text(row?.BillingPeriodEnd);
    if(start&&(!periodStart||Date.parse(start)<Date.parse(periodStart))) periodStart=start;
    if(end&&(!periodEnd||Date.parse(end)>Date.parse(periodEnd))) periodEnd=end;
    const isToday=dateOnly(row?.ChargePeriodStart)===today;
    if(kind==='cpu'){
      const value=cpuToMs(row?.ConsumedQuantity,row?.ConsumedUnit);
      cpuMs+=value; if(isToday) todayCpuMs+=value;
    } else if(kind==='requests'){
      const value=n(row?.ConsumedQuantity);
      requests+=value; if(isToday) todayRequests+=value;
    }
  }
  const cpuUsedPct=pct(cpuMs,CF_WORKERS_CPU_INCLUDED_MS);
  const requestUsedPct=pct(requests,CF_WORKERS_REQUESTS_INCLUDED);
  const projectedCpuMs=linearProjection(cpuMs,periodStart,periodEnd,now);
  const projectedRequests=linearProjection(requests,periodStart,periodEnd,now);
  const currentOverageUsd=Math.max(0,cpuMs-CF_WORKERS_CPU_INCLUDED_MS)/1_000_000*CF_CPU_OVERAGE_PER_MILLION_USD+
    Math.max(0,requests-CF_WORKERS_REQUESTS_INCLUDED)/1_000_000*CF_REQUEST_OVERAGE_PER_MILLION_USD;
  const projectedOverageUsd=(projectedCpuMs==null?0:Math.max(0,projectedCpuMs-CF_WORKERS_CPU_INCLUDED_MS)/1_000_000*CF_CPU_OVERAGE_PER_MILLION_USD)+
    (projectedRequests==null?0:Math.max(0,projectedRequests-CF_WORKERS_REQUESTS_INCLUDED)/1_000_000*CF_REQUEST_OVERAGE_PER_MILLION_USD);
  return {
    today, periodStart, periodEnd,
    cpuMs:Number(cpuMs.toFixed(3)), todayCpuMs:Number(todayCpuMs.toFixed(3)), cpuIncludedMs:CF_WORKERS_CPU_INCLUDED_MS,
    cpuUsedPct:Number(cpuUsedPct.toFixed(4)), cpuRemainingPct:Number(clamp(100-cpuUsedPct,0,100).toFixed(4)),
    requests:Number(requests.toFixed(3)), todayRequests:Number(todayRequests.toFixed(3)), requestsIncluded:CF_WORKERS_REQUESTS_INCLUDED,
    requestUsedPct:Number(requestUsedPct.toFixed(4)), requestRemainingPct:Number(clamp(100-requestUsedPct,0,100).toFixed(4)),
    projectedCpuMs:projectedCpuMs==null?null:Number(projectedCpuMs.toFixed(3)), projectedCpuPct:projectedCpuMs==null?null:Number(pct(projectedCpuMs,CF_WORKERS_CPU_INCLUDED_MS).toFixed(4)),
    projectedRequests:projectedRequests==null?null:Number(projectedRequests.toFixed(3)), projectedRequestPct:projectedRequests==null?null:Number(pct(projectedRequests,CF_WORKERS_REQUESTS_INCLUDED).toFixed(4)),
    billedCost:Number(billedCost.toFixed(6)), currentOverageUsd:Number(currentOverageUsd.toFixed(6)), projectedOverageUsd:Number(projectedOverageUsd.toFixed(6))
  };
}

async function cloudflareBillingSummary(env, now=Date.now()) {
  const token=text(env.CLOUDFLARE_BILLING_READ_TOKEN);
  const account=text(env.AI_GATEWAY_ACCOUNT_ID);
  if(!token||!account) return {configured:false,ok:false,reason:'not_configured'};
  const cache=safeJson(await metaGet(env,'cloudflare_billing_cache'),null);
  if(cache?.workers&&now-(Date.parse(cache.at)||0)<CF_BILLING_CACHE_MS) return cache;
  try {
    const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/billable-usage`,{headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},cache:'no-store'});
    const raw=await r.json().catch(()=>null);
    const rows=Array.isArray(raw?.result)?raw.result:[];
    if(!r.ok||raw?.success===false){
      const out={configured:true,ok:false,at:iso(now),reason:`http_${r.status}`};
      await metaPut(env,'cloudflare_billing_cache',JSON.stringify(out)); return out;
    }
    let billed=0; let currency='USD'; const products={};
    for(const row of rows){
      billed+=n(row?.BilledCost); currency=text(row?.BillingCurrency)||currency;
      const family=text(row?.ServiceName||row?.ServiceFamilyName||row?.x_ProductFamilyName||'Cloudflare');
      const key=family||'Cloudflare';
      const item=products[key]||(products[key]={billedCost:0,metrics:[]}); item.billedCost+=n(row?.BilledCost);
      if(item.metrics.length<8) item.metrics.push({name:text(row?.x_BillableMetricName||row?.ChargeDescription),quantity:n(row?.ConsumedQuantity),unit:text(row?.ConsumedUnit)});
    }
    const workers=summarizeCloudflareWorkersUsage(rows,now);
    const out={configured:true,ok:true,at:iso(now),currency,billedCost:Number(billed.toFixed(6)),rows:rows.length,products,workers};
    await metaPut(env,'cloudflare_billing_cache',JSON.stringify(out)); return out;
  } catch(e){
    const out={configured:true,ok:false,at:iso(now),reason:text(e?.message||e).slice(0,160)};
    await metaPut(env,'cloudflare_billing_cache',JSON.stringify(out)); return out;
  }
}

function indicator(id,label,severity,detail=''){ return {id,label,severity,detail}; }
function worst(indicators){ return indicators.some(x=>x.severity==='red')?'red':indicators.some(x=>x.severity==='yellow')?'yellow':'green'; }
function icon(s){ return s==='red'?'🔴':s==='yellow'?'🟡':'🟢'; }
function cloudflareSeverity(cf){
  if(!cf?.configured||!cf?.ok||!cf?.workers) return 'yellow';
  const w=cf.workers; const actual=Math.max(n(w.cpuUsedPct),n(w.requestUsedPct)); const projected=Math.max(n(w.projectedCpuPct),n(w.projectedRequestPct));
  if(n(w.currentOverageUsd)>0||actual>=100) return 'red';
  if(projected>=100||actual>=80||projected>=80) return 'yellow';
  return 'green';
}
function cloudflareDetail(cf){
  if(!cf?.configured) return 'Billing Read não configurado';
  if(!cf?.ok) return `uso faturável indisponível (${text(cf?.reason)||'erro'})`;
  const w=cf.workers||{};
  return `CPU ${fmtNum(w.cpuMs)} / ${fmtNum(w.cpuIncludedMs)} ms (${fmtPct(w.cpuUsedPct)}) · requests ${fmtNum(w.requests)} / ${fmtNum(w.requestsIncluded)} (${fmtPct(w.requestUsedPct)}) · hoje ${fmtNum(w.todayCpuMs)} ms`;
}

export function githubActionsSeverity({ dormant=false, dispatches=0, previousDispatches=0, pendingPostgameTasks=0, hoursToNext=Infinity, hasPrevious=false } = {}) {
  const current=n(dispatches);
  const previous=n(previousDispatches);
  const increased=hasPrevious && current>previous;
  const quietWindow=dormant && n(pendingPostgameTasks)===0 && Number(hoursToNext)>72;
  if (quietWindow && increased) {
    const delta=current-previous;
    return {severity:'red',detail:`${current} dispatch(es) /24h · +${delta} novo(s) em modo dormant sem tarefa pendente`};
  }
  if (current>8) return {severity:'yellow',detail:`${current} dispatch(es) nas últimas 24h · volume elevado, sem evidência de loop atual`};
  if (quietWindow) return {severity:'green',detail:`${current} dispatch(es) nas últimas 24h · estável; nenhum novo dispatch anômalo em modo dormant`};
  return {severity:'green',detail:`${current} dispatch(es) nas últimas 24h`};
}

export function isDailyDigestDue(br,lastDate){
  const hour=Number(br?.hour);
  return hour>=DAILY_HOUR_BRT && hour<DAILY_RECOVERY_END_HOUR_BRT && text(lastDate)!==text(br?.date);
}

export function dailyDigestDecision(br,lastDate,{lastAttemptAt='',now=Date.now()}={}){
  if(text(lastDate)===text(br?.date)) return {state:'sent',due:false};
  const hour=Number(br?.hour);
  if(hour<DAILY_HOUR_BRT) return {state:'waiting',due:false};
  if(hour>=DAILY_RECOVERY_END_HOUR_BRT) return {state:'missed',due:false};
  const lastMs=Date.parse(text(lastAttemptAt));
  if(Number.isFinite(lastMs)&&now-lastMs<DAILY_RETRY_MS){
    return {state:'retry_wait',due:false,nextAttemptAt:iso(lastMs+DAILY_RETRY_MS)};
  }
  return {state:lastAttemptAt?'retrying':'pending',due:true};
}

export async function collectHealthSnapshot(env, monitor = null, now = Date.now(), force = false) {
  const previous = safeJson(await metaGet(env,'snapshot'),null);
  if (!force && previous && Number(previous.policyVersion) === HEALTH_POLICY_VERSION && now-(Date.parse(previous.at)||0)<SNAPSHOT_TTL_MS) return previous;
  const [site, orchHealth, orchStatus, ai, providers, post, cfBilling, pushMetrics] = await Promise.all([
    fetchJson(`${text(env.SITE_BASE)||SITE}/`), fetchJson(`${ORCH}/health`), fetchJson(`${ORCH}/status`), aiUsageSummary(env,24), providerUsageSummary(env,24),
    env.DB.prepare(`SELECT COUNT(*) total,
      COALESCE(SUM(CASE WHEN public_status NOT IN ('resolved','gave_up') THEN 1 ELSE 0 END),0) public_pending,
      COALESCE(SUM(CASE WHEN public_status='gave_up' AND updated_at>=datetime('now','-24 hours') THEN 1 ELSE 0 END),0) public_gave_up_24h,
      COALESCE(SUM(CASE WHEN highlight_status<>'resolved' THEN 1 ELSE 0 END),0) highlight_pending
      FROM postgame_fastlane`).first(),
    cloudflareBillingSummary(env,now),
    env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM push_subscriptions WHERE active=1) AS active_subs,
      (SELECT COUNT(*) FROM push_deliveries WHERE status='sent'  AND updated_at>=datetime('now','-24 hours')) AS sent24h,
      (SELECT COUNT(*) FROM push_deliveries WHERE status='retry' AND updated_at>=datetime('now','-24 hours')) AS retry24h,
      (SELECT COUNT(*) FROM push_deliveries WHERE status='failed'AND updated_at>=datetime('now','-24 hours')) AS failed24h,
      (SELECT COUNT(*) FROM push_deliveries WHERE status='gone'  AND updated_at>=datetime('now','-24 hours')) AS gone24h,
      (SELECT COUNT(*) FROM push_event_dispatch WHERE status IN ('pending','enqueued') AND updated_at<datetime('now','-10 minutes')) AS stuck_dispatch,
      (SELECT COUNT(*) FROM push_deliveries WHERE status IN ('sending','retry') AND updated_at<datetime('now','-5 minutes')) AS stuck_delivery,
      (SELECT MAX(sent_at) FROM push_deliveries WHERE status='sent') AS last_push_at
    `).first().catch(()=>null)
  ]);
  const cfg=mailConfig(env);
  let probe=null; try { const row=await env.DB.prepare("SELECT value FROM postgame_meta WHERE key='mailer_probe'").first(); probe=safeJson(row?.value,null); } catch(_) {}
  const m=monitor||{};
  const os=orchStatus?.body||{};
  const dispatches=n(os.githubDispatchesLast24h);
  const dormant=text(os.workloadMode)==='dormant';
  const pendingOrchestrator=n(os.pendingPostgameTasks);
  const previousDispatches=n(previous?.orchestrator?.githubDispatchesLast24h);
  const nextRelevantMs=Date.parse(text(os.nextRelevantMatchAt));
  const hoursToNext=Number.isFinite(nextRelevantMs)?(nextRelevantMs-now)/3_600_000:Infinity;
  const githubSeverity=githubActionsSeverity({
    dormant, dispatches, previousDispatches, pendingPostgameTasks:pendingOrchestrator, hoursToNext, hasPrevious:Boolean(previous)
  });
  const active=n(m.activeGames);
  const lastPoll=n(m.lastPollAt);
  const staleLive=active>0 && (!lastPoll || now-lastPoll>3*60_000);
  const postPending=n(post?.public_pending);
  const gave=n(post?.public_gave_up_24h);
  const highlight=n(post?.highlight_pending);
  const perEventAnomaly=(providers.byEvent||[]).find(r=>n(r.searches)>8);
  const providerFailures=n(providers.failures);
  const geminiReady=Boolean(text(env.GEMINI_API_KEY));
  const gatewayAuthReady=Boolean(text(env.AI_GATEWAY_TOKEN));
  const workersAiReady=Boolean(env.AI);
  const indicators=[
    indicator('site','Site / Pages',site.ok?'green':'red',site.ok?`HTTP ${site.status}`:`indisponível (HTTP ${site.status||'erro'})`),
    indicator('orchestrator','Orchestrator',orchHealth.ok&&orchStatus.ok?'green':'red',orchHealth.ok?`${text(os.workloadMode)||'modo desconhecido'} · próximo: ${fmtDate(os.nextRelevantMatchAt)}`:'health/status indisponível'),
    indicator('github','GitHub Actions',githubSeverity.severity,githubSeverity.detail),
    indicator('brasileirao','Brasileirão / ESPN',m.ok===false?'red':'green',m.ok===false?'Sports Monitor reportou falha':'monitor esportivo operacional'),
    indicator('live','Ao Vivo',n(m.readinessRed)>0||staleLive?'red':'green',active?`${active} jogo(s) ativo(s) · readinessRed ${n(m.readinessRed)}`:'nenhum jogo ativo'),
    indicator('postgame','Pós-jogo',gave>0?'red':postPending>0?'yellow':'green',`${postPending} pendência(s) · ${gave} encerrada(s) sem solução em 24h`),
    indicator('highlights','Melhores Momentos',highlight>0?'yellow':'green',`${highlight} pendência(s)`),
    indicator('editorial','Editorial / Transmissões',Array.isArray(os.errors)&&os.errors.length?'yellow':'green',Array.isArray(os.errors)&&os.errors.length?`${os.errors.length} erro(s) no último ciclo`:'sem erro reportado pelo Orchestrator'),
    indicator('infra','Infraestrutura / SMTP',!cfg.configured||probe?.ok===false?'red':'green',`${cfg.transport} · ${maskAddress(cfg.to)}${probe?` · probe ${probe.ok?'OK':'FALHOU'}`:''}`),
    indicator('openai','IA / Custos',!geminiReady||!workersAiReady||!gatewayAuthReady?'yellow':perEventAnomaly?'red':providerFailures>3?'yellow':'green',`${providers.calls} chamada(s) multi-provider · ${providers.searches} busca(s) web · ${providerFailures} falha(s) /24h · Gateway ${text(env.AI_GATEWAY_ID)||'default'} · auth ${gatewayAuthReady?'OK':'pendente'}${perEventAnomaly?` · anomalia event ${text(perEventAnomaly.event_id)}`:''}`),
    indicator('cloudflare','Cloudflare / CPU & Requests',cloudflareSeverity(cfBilling),cloudflareDetail(cfBilling)),
  ];
  const snapshot={policyVersion:HEALTH_POLICY_VERSION,at:iso(now),state:worst(indicators),indicators,ai,providers,aiStack:{gateway:text(env.AI_GATEWAY_ID)||'default',gatewayAuthConfigured:gatewayAuthReady,geminiConfigured:geminiReady,workersAiConfigured:workersAiReady,openaiConfigured:Boolean(text(env.OPENAI_API_KEY))},orchestrator:{workloadMode:text(os.workloadMode),nextRelevantMatchAt:text(os.nextRelevantMatchAt),pendingPostgameTasks:pendingOrchestrator,githubDispatchesLast24h:dispatches},postgame:{pending:postPending,gaveUp24h:gave,highlightPending:highlight},mail:{transport:cfg.transport,configured:cfg.configured,destino:maskAddress(cfg.to)},cloudflareBilling:cfBilling,push:{activeSubs:n(pushMetrics?.active_subs),sent24h:n(pushMetrics?.sent24h),retry24h:n(pushMetrics?.retry24h),failed24h:n(pushMetrics?.failed24h),gone24h:n(pushMetrics?.gone24h),stuckDispatch:n(pushMetrics?.stuck_dispatch),stuckDelivery:n(pushMetrics?.stuck_delivery),lastPushAt:iso(pushMetrics?.last_push_at)}};
  await metaPut(env,'snapshot',JSON.stringify(snapshot));
  return snapshot;
}

function cloudflareDigestLines(cf){
  if(!cf?.configured) return ['CLOUDFLARE WORKERS — conta','Billing Read não configurado.'];
  if(!cf?.ok) return ['CLOUDFLARE WORKERS — conta',`Uso faturável indisponível: ${text(cf?.reason)||'erro'}.`];
  const w=cf.workers||{};
  const period=w.periodStart&&w.periodEnd?`${fmtDateOnly(w.periodStart)} → ${fmtDateOnly(w.periodEnd)}`:'período atual';
  const projectedCpu=w.projectedCpuMs==null?'—':`${fmtNum(w.projectedCpuMs)} ms (${fmtPct(w.projectedCpuPct)})`;
  const projectedReq=w.projectedRequests==null?'—':`${fmtNum(w.projectedRequests)} (${fmtPct(w.projectedRequestPct)})`;
  return [
    'CLOUDFLARE WORKERS — uso agregado da conta',
    `Hoje: CPU ${fmtNum(w.todayCpuMs)} ms · Requests ${fmtNum(w.todayRequests)}`,
    `Ciclo ${period}`,
    `CPU: ${fmtNum(w.cpuMs)} / ${fmtNum(w.cpuIncludedMs)} ms · ${fmtPct(w.cpuUsedPct)} usado · ${fmtPct(w.cpuRemainingPct)} disponível`,
    `Requests: ${fmtNum(w.requests)} / ${fmtNum(w.requestsIncluded)} · ${fmtPct(w.requestUsedPct)} usado · ${fmtPct(w.requestRemainingPct)} disponível`,
    `Projeção linear até o fechamento: CPU ${projectedCpu} · Requests ${projectedReq}`,
    `Excedente Workers registrado: ${fmtUsd(w.currentOverageUsd)} · projetado: ${fmtUsd(w.projectedOverageUsd)}`,
    `Uso faturável adicional Cloudflare registrado pela API: ${cf.currency||'USD'} ${Number(cf.billedCost||0).toFixed(2)}`,
    'Observação: a franquia Workers Paid é mensal; o consumo de hoje é informativo e os dados de billing podem ter atraso de processamento.'
  ];
}

function pushDigestLines(push) {
  if (!push) return ['PUSH / NOTIFICAÇÕES', 'Dados indisponíveis.'];
  const stuck = n(push.stuckDispatch) + n(push.stuckDelivery);
  return [
    'PUSH / NOTIFICAÇÕES — últimas 24h',
    `Assinaturas ativas: ${fmtNum(push.activeSubs)}`,
    `Entregas: ${fmtNum(push.sent24h)} enviadas · ${fmtNum(push.retry24h)} em retry · ${fmtNum(push.failed24h)} falhas · ${fmtNum(push.gone24h)} subscrições expiradas`,
    `Queue travada: ${stuck === 0 ? 'nenhuma' : `⚠️ ${n(push.stuckDispatch)} dispatch(es) + ${n(push.stuckDelivery)} delivery(ies)`}`,
    `Último push enviado: ${push.lastPushAt ? fmtDate(push.lastPushAt) : '—'}`
  ];
}
function digestMessage(snapshot, now=Date.now()) {
  const title=snapshot.state==='green'?'✅ Saúde diária — tudo normal':snapshot.state==='yellow'?'⚠️ Saúde diária — atenção':'🚨 Saúde diária — problema detectado';
  const total=snapshot.indicators.length; const green=snapshot.indicators.filter(x=>x.severity==='green').length;
  const lines=[
    'FÓRMULA DO GOL — HEALTH REPORT', `${brParts(now).date} · relatório diário 08:00 BRT`, '',
    `ESTADO GERAL: ${icon(snapshot.state)} ${snapshot.state.toUpperCase()} — ${green}/${total} verdes`, '',
    ...snapshot.indicators.map(x=>`${icon(x.severity)} ${x.label}: ${x.detail}`), '',
    'ORQUESTRADOR', `Modo: ${snapshot.orchestrator.workloadMode||'—'}`, `Próximo jogo relevante: ${fmtDate(snapshot.orchestrator.nextRelevantMatchAt)}`,
    `Dispatches GitHub 24h: ${snapshot.orchestrator.githubDispatchesLast24h}`, `Pendências pós-jogo: ${snapshot.postgame.pending}`, '',
    'IA / AI GATEWAY — últimas 24h', `Gateway: ${snapshot.aiStack?.gateway||'default'}`, `Chamadas registradas: ${snapshot.providers?.calls||0}`, `Buscas web registradas: ${snapshot.providers?.searches||0}`, `Tokens registrados: ${snapshot.providers?.totalTokens||0}`, `Falhas: ${snapshot.providers?.failures||0}`,
    ...(snapshot.providers?.byProvider||[]).map(r=>`- ${r.provider}: ${r.calls} chamada(s), ${r.searches} busca(s), ${r.total_tokens||0} tokens, ${r.failures||0} falha(s)`), '',
    ...pushDigestLines(snapshot.push), '',
    ...cloudflareDigestLines(snapshot.cloudflareBilling), '',
    'Custos Gemini/OpenAI: consultar AI Gateway/Google/OpenAI para faturamento final; o e-mail não inventa preço quando a resposta não expõe custo exato.', '',
    snapshot.state==='green'?'Nenhuma ação necessária.':'Verifique os itens amarelos/vermelhos acima. Alertas críticos são enviados separadamente.'
  ];
  return {subject:`[Fórmula do GOL] ${title}`,body:lines.join('\n')};
}
function incidentMessage(indicator,snapshot,recovered=false){
  return {
    subject: recovered?`[FDG][RECUPERADO] ✅ ${indicator.label}`:`[FDG][CRÍTICO] 🔴 ${indicator.label}`,
    body:[recovered?'Incidente normalizado.':'Problema confirmado pelo Health Monitor.', '', `Indicador: ${indicator.label}`, `Detalhe: ${indicator.detail}`, `Detectado/validado: ${fmtDate(snapshot.at)}`, '', `Estado geral: ${snapshot.state.toUpperCase()}`, `IA 24h: ${snapshot.providers?.calls||0} chamadas / ${snapshot.providers?.searches||0} buscas web`, '', recovered?'Nenhuma intervenção adicional é necessária se o estado permanecer verde.':'O Health Monitor não usa OpenAI para diagnosticar este alerta.'].join('\n')
  };
}

async function syncIncidents(env,snapshot,now=Date.now()){
  const reds=snapshot.indicators.filter(x=>x.severity==='red'); const active=new Set(reds.map(x=>x.id));
  for(const ind of reds){
    const key=`health:${ind.id}`; const row=await env.DB.prepare('SELECT * FROM health_incidents WHERE incident_key=?').bind(key).first();
    if(!row||text(row.status)!=='open'){
      const status=await sendMail(env,incidentMessage(ind,snapshot,false));
      await env.DB.prepare(`INSERT INTO health_incidents(incident_key,indicator,severity,status,detail,opened_at,last_seen_at,resolved_at,first_email_at,recovery_email_at,email_status)
        VALUES(?,?,?,'open',?,?,?,NULL,?,NULL,?) ON CONFLICT(incident_key) DO UPDATE SET indicator=excluded.indicator,severity='red',status='open',detail=excluded.detail,opened_at=excluded.opened_at,last_seen_at=excluded.last_seen_at,resolved_at=NULL,first_email_at=excluded.first_email_at,recovery_email_at=NULL,email_status=excluded.email_status`)
        .bind(key,ind.label,'red',ind.detail,iso(now),iso(now),iso(now),text(status)).run();
    } else {
      await env.DB.prepare('UPDATE health_incidents SET detail=?,last_seen_at=CURRENT_TIMESTAMP WHERE incident_key=?').bind(ind.detail,key).run();
    }
  }
  const open=await env.DB.prepare("SELECT * FROM health_incidents WHERE status='open'").all();
  for(const row of open?.results||[]){
    const id=text(row.incident_key).replace(/^health:/,''); if(active.has(id)) continue;
    const current=snapshot.indicators.find(x=>x.id===id)||{label:text(row.indicator),detail:'normalizado'};
    const status=await sendMail(env,incidentMessage(current,snapshot,true));
    await env.DB.prepare("UPDATE health_incidents SET status='resolved',resolved_at=CURRENT_TIMESTAMP,recovery_email_at=CURRENT_TIMESTAMP,email_status=? WHERE incident_key=?").bind(text(status),row.incident_key).run();
  }
}

async function markDailyAttempt(env,br,attempts,status,error='',now=Date.now()){
  await Promise.all([
    metaPut(env,'daily_attempts_date',br.date),
    metaPut(env,'daily_attempts_today',attempts),
    metaPut(env,'last_daily_attempt_at',iso(now)),
    metaPut(env,'last_daily_attempt_status',status),
    metaPut(env,'last_daily_attempt_error',error)
  ]);
}

export async function runHealthMonitor(env, monitor=null, now=Date.now()){
  const br=brParts(now);
  await Promise.all([metaPut(env,'last_health_started_at',iso(now)),metaPut(env,'daily_target_date',br.date)]);
  const [lastDigest,lastAttemptAt,attemptDate,attemptsRaw,lastAttemptStatus]=await Promise.all([
    metaGet(env,'daily_digest_date'),metaGet(env,'last_daily_attempt_at'),metaGet(env,'daily_attempts_date'),metaGet(env,'daily_attempts_today'),metaGet(env,'last_daily_attempt_status')
  ]);
  const decision=dailyDigestDecision(br,lastDigest,{lastAttemptAt:attemptDate===br.date?lastAttemptAt:'',now});
  let snapshot=null; let daily=decision.state;
  try {
    snapshot=await collectHealthSnapshot(env,monitor,now,false);

    // O relatório diário tem prioridade sobre a sincronização de incidentes. Assim,
    // mesmo uma execução pressionada por CPU/I/O tenta entregar o digest primeiro.
    if(decision.due){
      const attempts=(attemptDate===br.date?n(attemptsRaw):0)+1;
      await markDailyAttempt(env,br,attempts,'SENDING','',now);
      const status=await sendMail(env,digestMessage(snapshot,now));
      if(status==='sent'){
        daily='sent';
        await Promise.all([
          metaPut(env,'daily_digest_date',br.date),
          metaPut(env,'last_daily_sent_at',iso(now)),
          metaPut(env,'last_daily_attempt_status','SENT'),
          metaPut(env,'last_daily_attempt_error','')
        ]);
      } else {
        daily='retrying';
        await Promise.all([metaPut(env,'last_daily_attempt_status','RETRYING'),metaPut(env,'last_daily_attempt_error',text(status))]);
      }
    } else if(decision.state==='missed'&&(attemptDate!==br.date||text(lastAttemptStatus)!=='MISSED')){
      daily='missed';
      await Promise.all([
        metaPut(env,'daily_attempts_date',br.date),
        metaPut(env,'daily_attempts_today',0),
        metaPut(env,'last_daily_attempt_status','MISSED'),
        metaPut(env,'last_daily_attempt_error','janela_08_00_11_59_encerrada')
      ]);
    } else if(decision.state==='sent') {
      daily='sent';
    }

    await syncIncidents(env,snapshot,now);
    const completed={at:iso(now),state:snapshot.state,daily};
    await Promise.all([metaPut(env,'last_health_completed_at',iso(now)),metaPut(env,'last_health_run',JSON.stringify(completed)),metaPut(env,'last_health_error','')]);
    return {ok:true,state:snapshot.state,daily,snapshot};
  } catch(error){
    await metaPut(env,'last_health_error',`${iso(now)} ${text(error?.message||error).slice(0,240)}`).catch(()=>{});
    throw error;
  }
}

export async function healthMonitorStatus(env,now=Date.now()){
  const br=brParts(now);
  const [lastRun,snapshot,digestDate,targetDate,lastAttemptAt,lastAttemptStatus,lastAttemptError,attemptDate,attemptsRaw,lastSentAt,startedAt,completedAt,lastHealthError]=await Promise.all([
    metaGet(env,'last_health_run'),metaGet(env,'snapshot'),metaGet(env,'daily_digest_date'),metaGet(env,'daily_target_date'),metaGet(env,'last_daily_attempt_at'),metaGet(env,'last_daily_attempt_status'),metaGet(env,'last_daily_attempt_error'),metaGet(env,'daily_attempts_date'),metaGet(env,'daily_attempts_today'),metaGet(env,'last_daily_sent_at'),metaGet(env,'last_health_started_at'),metaGet(env,'last_health_completed_at'),metaGet(env,'last_health_error')
  ]);
  const decision=dailyDigestDecision(br,digestDate,{lastAttemptAt:attemptDate===br.date?lastAttemptAt:'',now});
  const completedMs=Date.parse(completedAt); const stale=!Number.isFinite(completedMs)||now-completedMs>15*60_000;
  const deliveryState=digestDate===br.date?'SENT':decision.state==='missed'?'MISSED':decision.state==='waiting'?'WAITING':decision.state==='retry_wait'||decision.state==='retrying'?'RETRYING':'PENDING';
  return {
    ok:true,
    lastRun:safeJson(lastRun,null),
    snapshot:safeJson(snapshot,null),
    dailyDigestDate:digestDate,
    dailyDelivery:{targetDate:targetDate||br.date,state:deliveryState,attemptsToday:attemptDate===br.date?n(attemptsRaw):0,lastAttemptAt,lastAttemptStatus,lastAttemptError,lastSentAt,nextAttemptAt:decision.nextAttemptAt||null,recoveryWindowBrt:'08:00-11:59'},
    scheduler:{healthCron:'*/5 * * * *',lastStartedAt:startedAt,lastCompletedAt:completedAt,stale,lastError:lastHealthError}
  };
}
