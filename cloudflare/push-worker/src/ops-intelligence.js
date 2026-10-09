export const OPS_INTELLIGENCE_CONSTANTS = Object.freeze({
  version: 1,
  ragRuntime: 'fdg-ops-rag',
  ragRuntimeVersion: 1,
  ragIndexSchemaVersion: 1,
  mcpGateway: 'fdg-ops-mcp',
  mcpGatewayVersion: 1,
  mcpProtocolVersion: '2026-07-28',
  mcpLegacyCompatibility: true,
  mcpReadOnly: true,
  fineTuning: 'not_used_by_design',
  cacheTtlMs: 5 * 60_000,
  maxTopK: 8,
  maxQueryChars: 320,
});

const DEFAULT_SITE = 'https://formuladogol.com.br';
const DEFAULT_ORCH = 'https://orchestrator.formuladogol.com.br';
let ragCache = null;

function text(v){ return String(v ?? '').trim(); }
function clamp(v,min,max){ return Math.min(max,Math.max(min,v)); }
function safeJson(v,f=null){ try{return JSON.parse(v);}catch(_){return f;} }
function stripAccents(v){ return text(v).normalize('NFKD').replace(/[\u0300-\u036f]/g,''); }
export function ragTokens(value){ return stripAccents(value).toLowerCase().match(/[a-z0-9][a-z0-9._:-]{1,}/g) || []; }
function termCounts(value){ const out=new Map(); for(const t of ragTokens(value)) out.set(t,(out.get(t)||0)+1); return out; }
function unique(xs){ return [...new Set(xs)]; }

async function fetchJson(url,{timeoutMs=6000}={}){
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort('timeout'),timeoutMs);
  try{
    const r=await fetch(url,{headers:{accept:'application/json','user-agent':'FormulaDoGol-OpsIntelligence/1.0'},signal:controller.signal,redirect:'follow'});
    const raw=await r.text(); const body=safeJson(raw,null);
    return {ok:r.ok&&body!==null,status:r.status,body,url:r.url||url};
  }catch(error){ return {ok:false,status:0,body:null,url,error:text(error?.message||error).slice(0,180)}; }
  finally{ clearTimeout(timer); }
}

export function rankRagChunks(index, query, {topK=5, scope='all'}={}){
  const chunks=Array.isArray(index?.chunks)?index.chunks:[];
  const q=text(query).slice(0,OPS_INTELLIGENCE_CONSTANTS.maxQueryChars);
  const qTokens=unique(ragTokens(q));
  if(!qTokens.length) return [];
  const filtered=scope==='all'?chunks:chunks.filter(c=>text(c?.scope)===scope);
  const N=Math.max(1,filtered.length);
  const avgdl=Math.max(1,filtered.reduce((s,c)=>s+Math.max(1,Number(c?.token_count||ragTokens(c?.text).length)),0)/N);
  const df=new Map();
  for(const chunk of filtered){
    const seen=new Set(ragTokens(`${chunk?.heading||''} ${chunk?.text||''}`));
    for(const t of qTokens) if(seen.has(t)) df.set(t,(df.get(t)||0)+1);
  }
  const normalizedPhrase=stripAccents(q).toLowerCase();
  const scored=[];
  for(const chunk of filtered){
    const combined=`${chunk?.heading||''} ${chunk?.text||''}`;
    const counts=termCounts(combined); const dl=Math.max(1,Number(chunk?.token_count||ragTokens(combined).length));
    let score=0; const matched=[];
    for(const t of qTokens){
      const tf=counts.get(t)||0; if(!tf) continue;
      matched.push(t);
      const freq=df.get(t)||0;
      const idf=Math.log(1+(N-freq+0.5)/(freq+0.5));
      const k1=1.5,b=0.75;
      score += idf*((tf*(k1+1))/(tf+k1*(1-b+b*(dl/avgdl))));
      if(stripAccents(text(chunk?.heading)).toLowerCase().includes(t)) score += 0.8;
      if(stripAccents(text(chunk?.path)).toLowerCase().includes(t)) score += 0.35;
    }
    const hay=stripAccents(combined).toLowerCase();
    if(normalizedPhrase.length>=8 && hay.includes(normalizedPhrase)) score+=2.5;
    const coverage=matched.length/qTokens.length;
    score += coverage*0.75;
    if(score>0) scored.push({
      id:text(chunk?.id), path:text(chunk?.path), heading:text(chunk?.heading), scope:text(chunk?.scope)||'operations',
      score:Number(score.toFixed(6)), coverage:Number(coverage.toFixed(4)), matched_terms:matched,
      text:text(chunk?.text)
    });
  }
  scored.sort((a,b)=>b.score-a.score || b.coverage-a.coverage || a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
  return scored.slice(0,clamp(Number(topK)||5,1,OPS_INTELLIGENCE_CONSTANTS.maxTopK));
}

export async function loadOpsRag(env,{force=false,now=Date.now()}={}){
  if(!force&&ragCache&&now-ragCache.at<OPS_INTELLIGENCE_CONSTANTS.cacheTtlMs) return ragCache.value;
  const site=text(env?.SITE_BASE)||DEFAULT_SITE;
  const [manifestRes,indexRes]=await Promise.all([
    fetchJson(`${site}/dados-br/rag-manifest.json`),
    fetchJson(`${site}/dados-br/ops-rag-index.json`),
  ]);
  const manifest=manifestRes.ok?manifestRes.body:null;
  const index=indexRes.ok?indexRes.body:null;
  const problems=[];
  if(!manifestRes.ok) problems.push(`manifest_http_${manifestRes.status||0}`);
  if(!indexRes.ok) problems.push(`index_http_${indexRes.status||0}`);
  if(Number(manifest?.schema_version||0)<2) problems.push('manifest_schema_lt_2');
  if(manifest?.production_rag_enabled!==true) problems.push('production_rag_disabled');
  if(Number(index?.schema_version||0)!==OPS_INTELLIGENCE_CONSTANTS.ragIndexSchemaVersion) problems.push('index_schema_mismatch');
  if(text(index?.runtime)!==OPS_INTELLIGENCE_CONSTANTS.ragRuntime) problems.push('index_runtime_mismatch');
  if(Number(index?.runtime_version||0)!==OPS_INTELLIGENCE_CONSTANTS.ragRuntimeVersion) problems.push('index_runtime_version_mismatch');
  if(!(Number(index?.chunk_count||0)>0)&&!(Array.isArray(index?.chunks)&&index.chunks.length>0)) problems.push('index_empty');
  const value={ok:problems.length===0,problems,manifest,index,site,manifestStatus:manifestRes.status,indexStatus:indexRes.status};
  ragCache={at:now,value};
  return value;
}

export async function searchOpsRag(env,query,{topK=5,scope='all',force=false}={}){
  const q=text(query).slice(0,OPS_INTELLIGENCE_CONSTANTS.maxQueryChars);
  if(q.length<2) return {ok:false,error:'query_required',query:q,results:[]};
  const loaded=await loadOpsRag(env,{force});
  if(!loaded.ok) return {ok:false,error:'rag_runtime_unavailable',problems:loaded.problems,query:q,results:[]};
  const allowedScope=['all','incidents','runbooks','operations'].includes(scope)?scope:'all';
  const results=rankRagChunks(loaded.index,q,{topK,scope:allowedScope});
  return {
    ok:true, runtime:OPS_INTELLIGENCE_CONSTANTS.ragRuntime, version:OPS_INTELLIGENCE_CONSTANTS.ragRuntimeVersion,
    query:q, scope:allowedScope, source_sha256:text(loaded.index?.source_sha256), source_count:Number(loaded.index?.source_count||0),
    chunk_count:Number(loaded.index?.chunk_count||0), results,
    authority:'diagnosis_and_context_only', generation:'performed_by_mcp_host_model', external_ai_calls:0, web_search_calls:0
  };
}

export async function opsReliabilityContext(env){
  const site=text(env?.SITE_BASE)||DEFAULT_SITE; const orch=text(env?.ORCHESTRATOR_BASE)||DEFAULT_ORCH;
  const [state,factual,orchHealth,orchStatus]=await Promise.all([
    fetchJson(`${site}/dados-br/estado-confiabilidade.json`),
    fetchJson(`${site}/dados-br/auditoria-publicos-identidade.json`),
    fetchJson(`${orch}/health`),
    fetchJson(`${orch}/status`),
  ]);
  return {
    ok:Boolean(state.ok&&factual.ok&&orchHealth.ok&&orchStatus.ok),
    fetched_at:new Date().toISOString(),
    reliability_state:state.body||null,
    factual_integrity:factual.body?{
      schema_version:Number(factual.body.schema_version||0),
      total_registros_publicos:Number(factual.body.total_registros_publicos||0),
      total_ok:Number(factual.body.total_ok||0), total_avisos:Number(factual.body.total_avisos||0), total_criticos:Number(factual.body.total_criticos||0),
      achados:Array.isArray(factual.body.achados)?factual.body.achados.slice(0,20):[]
    }:null,
    orchestrator_health:orchHealth.body||null,
    orchestrator_status:orchStatus.body||null,
    fetch_status:{state:state.status,factual:factual.status,orchestrator_health:orchHealth.status,orchestrator_status:orchStatus.status}
  };
}

export async function opsIntelligenceStatus(env,{force=false}={}){
  const loaded=await loadOpsRag(env,{force});
  const chunks=Number(loaded.index?.chunk_count||0); const sources=Number(loaded.index?.source_count||0);
  return {
    ok:loaded.ok,
    service:'fdg-ops-intelligence', version:OPS_INTELLIGENCE_CONSTANTS.version,
    rag:{
      enabled:true, ready:loaded.ok, runtime:OPS_INTELLIGENCE_CONSTANTS.ragRuntime, version:OPS_INTELLIGENCE_CONSTANTS.ragRuntimeVersion,
      retrieval:text(loaded.index?.retrieval)||'deterministic_bm25_lexical', sourceCount:sources, chunkCount:chunks,
      sourceSha256:text(loaded.index?.source_sha256), authority:'diagnosis_and_context_only',
      generation:'mcp_host_model', externalAiCallsPerRetrieval:0, webSearchCallsPerRetrieval:0, problems:loaded.problems
    },
    mcp:{
      enabled:true, gateway:OPS_INTELLIGENCE_CONSTANTS.mcpGateway, version:OPS_INTELLIGENCE_CONSTANTS.mcpGatewayVersion,
      protocolVersion:OPS_INTELLIGENCE_CONSTANTS.mcpProtocolVersion, legacyCompatibility:OPS_INTELLIGENCE_CONSTANTS.mcpLegacyCompatibility,
      readOnly:true, endpoint:'/mcp', tools:5, resources:2,
      authentication:text(env?.OPS_MCP_TOKEN)?'optional_bearer_enabled':'public_read_only_bounded'
    },
    fineTuning:OPS_INTELLIGENCE_CONSTANTS.fineTuning,
    criticalPath:false,
    failOpenForSportingPipeline:true
  };
}
