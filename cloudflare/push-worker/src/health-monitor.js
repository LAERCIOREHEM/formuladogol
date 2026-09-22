import { sendMail, mailConfig, maskAddress } from './mailer.js';
import { aiUsageSummary } from './ai-usage.js';

const SITE = 'https://formuladogol.com.br';
const ORCH = 'https://orchestrator.formuladogol.com.br';
const SNAPSHOT_TTL_MS = 5 * 60_000;
const DAILY_HOUR_BRT = 8;
const HEALTH_POLICY_VERSION = 2;

function text(v) { return String(v ?? '').trim(); }
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function iso(ms = Date.now()) { return new Date(ms).toISOString(); }
function safeJson(s, f = null) { try { return JSON.parse(s); } catch (_) { return f; } }
function brParts(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone:'America/Sao_Paulo', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(new Date(now));
  const g = (t) => parts.find((p) => p.type === t)?.value || '';
  return { date:`${g('year')}-${g('month')}-${g('day')}`, hour:Number(g('hour')), minute:Number(g('minute')) };
}
function fmtDate(v) {
  const ms = Date.parse(text(v)); if (!Number.isFinite(ms)) return text(v) || '—';
  return new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}).format(new Date(ms));
}
async function metaGet(env,key){ const r=await env.DB.prepare('SELECT value FROM health_monitor_meta WHERE key=?').bind(key).first(); return text(r?.value); }
async function metaPut(env,key,value){ await env.DB.prepare(`INSERT INTO health_monitor_meta(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(key,String(value ?? '')).run(); }
async function fetchJson(url, timeout=10000) {
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),timeout);
  try { const r=await fetch(url,{cache:'no-store',signal:c.signal}); const body=await r.json().catch(()=>null); return {ok:r.ok,status:r.status,body}; }
  catch(e){ return {ok:false,status:0,error:text(e?.message||e)}; } finally { clearTimeout(t); }
}
function indicator(id,label,severity,detail=''){ return {id,label,severity,detail}; }
function worst(indicators){ return indicators.some(x=>x.severity==='red')?'red':indicators.some(x=>x.severity==='yellow')?'yellow':'green'; }
function icon(s){ return s==='red'?'🔴':s==='yellow'?'🟡':'🟢'; }

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
  return Number(br?.hour)===DAILY_HOUR_BRT && text(lastDate)!==text(br?.date);
}

export async function collectHealthSnapshot(env, monitor = null, now = Date.now(), force = false) {
  const previous = safeJson(await metaGet(env,'snapshot'),null);
  if (!force && previous && Number(previous.policyVersion) === HEALTH_POLICY_VERSION && now-(Date.parse(previous.at)||0)<SNAPSHOT_TTL_MS) return previous;
  const [site, orchHealth, orchStatus, ai, post] = await Promise.all([
    fetchJson(`${text(env.SITE_BASE)||SITE}/`), fetchJson(`${ORCH}/health`), fetchJson(`${ORCH}/status`), aiUsageSummary(env,24),
    env.DB.prepare(`SELECT COUNT(*) total,
      COALESCE(SUM(CASE WHEN public_status NOT IN ('resolved','gave_up') THEN 1 ELSE 0 END),0) public_pending,
      COALESCE(SUM(CASE WHEN public_status='gave_up' AND updated_at>=datetime('now','-24 hours') THEN 1 ELSE 0 END),0) public_gave_up_24h,
      COALESCE(SUM(CASE WHEN highlight_status<>'resolved' THEN 1 ELSE 0 END),0) highlight_pending
      FROM postgame_fastlane`).first()
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
  const perEventAnomaly=(ai.byEvent||[]).find(r=>n(r.web_searches)>7);
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
    indicator('openai','OpenAI / Web Search',perEventAnomaly?'red':ai.failures>3?'yellow':'green',`${ai.calls} chamada(s), ${ai.webSearches} web search(es), ${ai.failures} falha(s) /24h${perEventAnomaly?` · anomalia event ${text(perEventAnomaly.event_id)}`:''}`),
  ];
  const snapshot={policyVersion:HEALTH_POLICY_VERSION,at:iso(now),state:worst(indicators),indicators,ai,orchestrator:{workloadMode:text(os.workloadMode),nextRelevantMatchAt:text(os.nextRelevantMatchAt),pendingPostgameTasks:pendingOrchestrator,githubDispatchesLast24h:dispatches},postgame:{pending:postPending,gaveUp24h:gave,highlightPending:highlight},mail:{transport:cfg.transport,configured:cfg.configured,destino:maskAddress(cfg.to)}};
  await metaPut(env,'snapshot',JSON.stringify(snapshot));
  return snapshot;
}

function digestMessage(snapshot, now=Date.now()) {
  const title=snapshot.state==='green'?'✅ Saúde diária — tudo normal':snapshot.state==='yellow'?'⚠️ Saúde diária — atenção':'🚨 Saúde diária — problema detectado';
  const lines=[
    'FÓRMULA DO GOL — HEALTH REPORT', `${brParts(now).date} · 08:00 BRT`, '',
    `ESTADO GERAL: ${icon(snapshot.state)} ${snapshot.state.toUpperCase()} — ${snapshot.indicators.filter(x=>x.severity==='green').length}/10 verdes`, '',
    ...snapshot.indicators.map(x=>`${icon(x.severity)} ${x.label}: ${x.detail}`), '',
    'ORQUESTRADOR', `Modo: ${snapshot.orchestrator.workloadMode||'—'}`, `Próximo jogo relevante: ${fmtDate(snapshot.orchestrator.nextRelevantMatchAt)}`,
    `Dispatches GitHub 24h: ${snapshot.orchestrator.githubDispatchesLast24h}`, `Pendências pós-jogo: ${snapshot.postgame.pending}`, '',
    'OPENAI / WEB SEARCH — últimas 24h', `Chamadas registradas no Worker: ${snapshot.ai.calls}`, `Web searches registradas: ${snapshot.ai.webSearches}`, `Falhas: ${snapshot.ai.failures}`,
    ...(snapshot.ai.byPurpose||[]).map(r=>`- ${r.purpose}: ${r.calls} chamada(s), ${r.web_searches} web search(es)`), '',
    snapshot.state==='green'?'Nenhuma ação necessária.':'Verifique os itens amarelos/vermelhos acima. Alertas críticos são enviados separadamente.'
  ];
  return {subject:`[Fórmula do GOL] ${title}`,body:lines.join('\n')};
}
function incidentMessage(indicator,snapshot,recovered=false){
  return {
    subject: recovered?`[FDG][RECUPERADO] ✅ ${indicator.label}`:`[FDG][CRÍTICO] 🔴 ${indicator.label}`,
    body:[recovered?'Incidente normalizado.':'Problema confirmado pelo Health Monitor.', '', `Indicador: ${indicator.label}`, `Detalhe: ${indicator.detail}`, `Detectado/validado: ${fmtDate(snapshot.at)}`, '', `Estado geral: ${snapshot.state.toUpperCase()}`, `OpenAI 24h: ${snapshot.ai.calls} chamadas / ${snapshot.ai.webSearches} web searches`, '', recovered?'Nenhuma intervenção adicional é necessária se o estado permanecer verde.':'O Health Monitor não usa OpenAI para diagnosticar este alerta.'].join('\n')
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

export async function runHealthMonitor(env, monitor=null, now=Date.now()){
  const snapshot=await collectHealthSnapshot(env,monitor,now,false);
  await syncIncidents(env,snapshot,now);
  const br=brParts(now); const last=await metaGet(env,'daily_digest_date');
  let daily='not_due';
  if(isDailyDigestDue(br,last)){
    daily=await sendMail(env,digestMessage(snapshot,now));
    if(daily==='sent') await metaPut(env,'daily_digest_date',br.date);
  }
  await metaPut(env,'last_health_run',JSON.stringify({at:iso(now),state:snapshot.state,daily}));
  return {ok:true,state:snapshot.state,daily,snapshot};
}

export async function healthMonitorStatus(env){
  return {ok:true,lastRun:safeJson(await metaGet(env,'last_health_run'),null),snapshot:safeJson(await metaGet(env,'snapshot'),null),dailyDigestDate:await metaGet(env,'daily_digest_date')};
}
