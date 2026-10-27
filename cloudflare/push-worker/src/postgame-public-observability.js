import { estimateProviderCost } from './ai-usage.js';

const text = (value) => String(value ?? '').trim();
const iso = (now = Date.now()) => new Date(now).toISOString();
function stamp(value) {
  const raw = text(value);
  const parsed = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(raw)
    ? raw.replace(' ', 'T') + 'Z' : raw;
  const ms = Date.parse(parsed);
  return raw && Number.isFinite(ms) ? ms : null;
}
function duration(from, to) {
  const a=stamp(from), b=stamp(to);
  return a == null || b == null ? null : Math.round((b-a)/6000)/10;
}
function explicitTimestamp(value, now=Date.now()) {
  const raw=text(value);
  if(!/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d/.test(raw) || !/(?:Z|[+-]\d\d:?\d\d)$/i.test(raw)) return null;
  const ms=stamp(raw);
  return ms!=null && ms>=Date.UTC(2016,0,1) && ms<=now+600000 ? iso(ms):null;
}
export function extractArticlePublishedAt(html, now=Date.now()) {
  const source=text(html).slice(0,400000),found=[];
  for(const match of source.matchAll(/<meta\b[^>]*>/gi)){
    if(!/(?:article:published_time|datepublished|pubdate|publication_date|date_published)/i.test(match[0]))continue;
    const value=match[0].match(/\bcontent\s*=\s*["']([^"']+)["']/i);
    if(value)found.push(value[1]);
  }
  for(const match of source.matchAll(/"datePublished"\s*:\s*"([^"]+)"/gi))found.push(match[1]);
  for(const value of found){const date=explicitTimestamp(value,now);if(date)return date;}
  return null;
}

export async function recordPublicSourceObservation(env,item={}){
  const eventId=text(item.eventId),url=text(item.url);
  if(!env?.DB||!eventId||!url)return false;
  const at=iso(item.at??Date.now()),accepted=item.outcome==='accepted';
  const fields=[...new Set((item.fields||[]).map(text))].filter((f)=>['publico','publico_pagante','renda'].includes(f)).join(',');
  const sql=[
    'INSERT INTO postgame_public_source_audit(event_id,url,provider,first_checked_at,last_checked_at,published_at,first_accepted_at,check_count,rejected_count,accepted_count,last_outcome,last_reason,accepted_fields,updated_at)',
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)',
    'ON CONFLICT(event_id,url) DO UPDATE SET',
    "provider=CASE WHEN postgame_public_source_audit.provider='' THEN excluded.provider ELSE postgame_public_source_audit.provider END,",
    'last_checked_at=excluded.last_checked_at,',
    'published_at=COALESCE(postgame_public_source_audit.published_at,excluded.published_at),',
    'first_accepted_at=COALESCE(postgame_public_source_audit.first_accepted_at,excluded.first_accepted_at),',
    'check_count=postgame_public_source_audit.check_count+1,',
    'rejected_count=postgame_public_source_audit.rejected_count+excluded.rejected_count,',
    'accepted_count=postgame_public_source_audit.accepted_count+excluded.accepted_count,',
    'last_outcome=excluded.last_outcome,last_reason=excluded.last_reason,',
    "accepted_fields=CASE WHEN excluded.accepted_fields<>'' THEN excluded.accepted_fields ELSE postgame_public_source_audit.accepted_fields END,",
    'updated_at=CURRENT_TIMESTAMP',
  ].join(' ');
  try{
    await env.DB.prepare(sql).bind(
      eventId,url.slice(0,1800),text(item.provider).slice(0,60),at,at,
      explicitTimestamp(item.publishedAt,item.at??Date.now()),accepted?at:null,
      1,accepted?0:1,accepted?1:0,text(item.outcome).slice(0,60),
      text(item.reason).slice(0,220),fields
    ).run();
    return true;
  }catch(e){
    console.error('hunter_source_audit_failed:',text(e?.message||e).slice(0,180));
    return false;
  }
}
export async function recordPublicResolution(env,eventId,options={}){
  if(!env?.DB||!text(eventId))return false;
  try{
    await env.DB.prepare('INSERT OR IGNORE INTO postgame_public_resolution_audit(event_id,first_observed_resolved_at,channel,source_url) VALUES(?,?,?,?)')
      .bind(text(eventId),iso(options.at??Date.now()),text(options.channel).slice(0,80),text(options.sourceUrl).slice(0,1800)).run();
    return true;
  }catch(e){
    console.error('hunter_resolution_audit_failed:',text(e?.message||e).slice(0,180));
    return false;
  }
}

const num=(v)=>Number.isFinite(Number(v))?Number(v):0;
export function buildPublicDiscoveryDiagnostic(match,sources=[],usage=[],env={}){
  const finalAt=text(match.final_at);
  const sourceOrdered=[...sources].sort((a,b)=>String(a.first_discovered_at||'').localeCompare(String(b.first_discovered_at||'')));
  const accepted=sourceOrdered.filter((x)=>num(x.accepted_count)>0);
  const validated=accepted.slice().sort((a,b)=>String(a.first_accepted_at||'').localeCompare(String(b.first_accepted_at||'')))[0]||null;
  const published=accepted.filter((x)=>stamp(x.published_at)!=null).sort((a,b)=>stamp(a.published_at)-stamp(b.published_at))[0]||null;
  const checked=sources.reduce((s,x)=>s+num(x.check_count),0);
  const rejections=sources.reduce((s,x)=>s+num(x.rejected_count),0);
  const approved=sources.reduce((s,x)=>s+num(x.accepted_count),0);
  const reasons={};
  for(const row of sources){
    if(!num(row.rejected_count))continue;
    const reason=text(row.last_reason)||text(row.last_outcome)||'unclassified';
    reasons[reason]=(reasons[reason]||0)+num(row.rejected_count);
  }
  // O último motivo é explícito: contagens anteriores podem ter outros motivos.
  const providerCosts=[],cost={apiCalls:0,webSearches:0,failures:0,estimatedUsd:0};
  for(const row of usage){
    const estimated=estimateProviderCost({provider:row.provider,model:row.model,searches:row.searches,inputTokens:row.input_tokens,outputTokens:row.output_tokens},env);
    const item={provider:text(row.provider),model:text(row.model),calls:num(row.calls),
      searches:num(row.searches),failures:num(row.failures),
      estimatedUsd:estimated.costKnown?estimated.knownUsd:null};
    providerCosts.push(item);
    cost.apiCalls+=item.calls;cost.webSearches+=item.searches;cost.failures+=item.failures;
    if(item.estimatedUsd!=null)cost.estimatedUsd+=item.estimatedUsd;
  }
  cost.estimatedUsd=Number(cost.estimatedUsd.toFixed(6));
  const resolvedAt=text(match.first_observed_resolved_at)||null;
  return {
    event_id:text(match.event_id),home:text(match.home),away:text(match.away),
    status:text(match.public_status),
    public:match.publico==null?null:Number(match.publico),
    revenue:match.renda==null?null:Number(match.renda),
    timeline:{
      finalAt:finalAt||null,
      firstUrlDiscoveredAt:sourceOrdered.find((x)=>x.first_discovered_at)?.first_discovered_at||null,
      firstValidatedAt:validated?.first_accepted_at||null,
      firstValidatedUrl:validated?.url||null,
      sourcePublishedAt:published?.published_at||null,
      firstObservedResolvedAt:resolvedAt,
      resolutionChannel:text(match.channel)||null,
      finalToFirstUrlMinutes:duration(finalAt,sourceOrdered.find((x)=>x.first_discovered_at)?.first_discovered_at),
      publishedToValidatedMinutes:published?duration(published.published_at,published.first_accepted_at):null,
      finalToResolvedMinutes:duration(finalAt,resolvedAt),
    },
    sourceFunnel:{urls:sources.length,checks:checked,rejected:rejections,accepted:approved,
      acceptancePct:checked?Math.round(approved/checked*1000)/10:null,
      lastRejectionReasons:reasons},
    cost:{...cost,byProvider:providerCosts,
      note:'Estimativa conservadora dos registros disponíveis; Workers AI não convertido para USD.'},
    sources:[...sources].sort((a,b)=>num(b.accepted_count)-num(a.accepted_count) ||
      String(b.first_discovered_at||'').localeCompare(String(a.first_discovered_at||''))).slice(0,15).map((row)=>({
      url:text(row.url),provider:text(row.provider),
      discoveredAt:row.first_discovered_at||null,firstCheckedAt:row.first_checked_at||null,
      lastCheckedAt:row.last_checked_at||null,publishedAt:row.published_at||null,
      firstValidatedAt:row.first_accepted_at||null,
      attempts:num(row.check_count),accepted:num(row.accepted_count),rejected:num(row.rejected_count),
      lastOutcome:text(row.last_outcome),lastReason:text(row.last_reason),
      fields:text(row.accepted_fields).split(',').filter(Boolean)
    }))
  };
}

export async function readPublicDiscoveryDiagnostics(env,eventIds=[]){
  const ids=[...new Set((eventIds||[]).map(text).filter((x)=>/^[a-zA-Z0-9._:-]{1,128}$/.test(x)))].slice(0,20);
  const where=ids.length?'WHERE p.event_id IN ('+ids.map(()=>'?').join(',')+')':"WHERE p.league='bra.1'";
  const select=[
    'SELECT p.event_id,p.home,p.away,p.final_at,p.public_status,p.publico,p.renda,',
    'r.first_observed_resolved_at,r.channel,r.source_url',
    'FROM postgame_fastlane p LEFT JOIN postgame_public_resolution_audit r ON r.event_id=p.event_id',
    where,'ORDER BY p.final_at DESC LIMIT '+(ids.length?20:10)
  ].join(' ');
  const statement=env.DB.prepare(select);
  const games=ids.length?await statement.bind(...ids).all():await statement.all();
  const matches=games?.results||[];
  if(!matches.length)return {ok:true,version:1,rows:[],summary:{games:0},notes:[]};
  const target=matches.map((x)=>x.event_id),marks=target.map(()=>'?').join(',');
  const sourceSql=[
    'SELECT c.event_id,c.url,c.provider,c.discovered_at AS first_discovered_at,',
    'a.first_checked_at,a.last_checked_at,a.published_at,a.first_accepted_at,',
    'a.check_count,a.rejected_count,a.accepted_count,a.last_outcome,a.last_reason,a.accepted_fields',
    'FROM postgame_source_cache c LEFT JOIN postgame_public_source_audit a',
    'ON a.event_id=c.event_id AND a.url=c.url',
    'WHERE c.event_id IN ('+marks+') ORDER BY c.event_id,c.discovered_at DESC LIMIT 500'
  ].join(' ');
  const ledgerSql=[
    'SELECT event_id,provider,model,COUNT(*) AS calls,',
    'COALESCE(SUM(search_calls),0) AS searches,',
    'COALESCE(SUM(input_tokens),0) AS input_tokens,',
    'COALESCE(SUM(output_tokens),0) AS output_tokens,',
    'COALESCE(SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END),0) AS failures',
    'FROM ai_provider_ledger WHERE event_id IN ('+marks+')',
    "AND purpose IN ('postgame_public','postgame_extract')",
    'GROUP BY event_id,provider,model'
  ].join(' ');
  const [sr,ur]=await Promise.all([
    env.DB.prepare(sourceSql).bind(...target).all(),
    env.DB.prepare(ledgerSql).bind(...target).all()
  ]);
  const sourceRows=sr?.results||[],usageRows=ur?.results||[];
  const rows=matches.map((match)=>buildPublicDiscoveryDiagnostic(match,
    sourceRows.filter((x)=>x.event_id===match.event_id),
    usageRows.filter((x)=>x.event_id===match.event_id),env));
  const durations=rows.map((r)=>r.timeline.finalToResolvedMinutes).filter((v)=>v!=null&&v>=0);
  return {ok:true,version:1,generatedAt:iso(),
    summary:{games:rows.length,resolved:rows.filter((r)=>r.status==='resolved').length,
      measuredResolutions:durations.length,
      meanFinalToResolutionMinutes:durations.length
        ?Math.round(durations.reduce((a,b)=>a+b,0)/durations.length*10)/10:null,
      estimatedUsd:Number(rows.reduce((n,r)=>n+r.cost.estimatedUsd,0).toFixed(6))},
    rows,
    notes:[
      'Publicação externa só é registrada quando a página informa horário completo com fuso.',
      'URL descoberta não prova que a reportagem já continha público/renda.',
      'Resolução representa a primeira observação após implantação da telemetria, não reconstrói tempos históricos.',
      'Valores USD são estimados; Workers AI consta no billing Cloudflare.'
    ]};
}
