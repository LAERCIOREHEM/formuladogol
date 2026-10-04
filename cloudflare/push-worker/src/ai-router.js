import { recordProviderUsage } from './ai-usage.js';
import { buildAttendanceSearchQueries, teamSearchAliasesNormalized, attendanceSourcePolicyText } from './postgame-search-profile.js';

function text(v){ return String(v ?? '').trim(); }
function safeJson(v,f=null){ try{return JSON.parse(v);}catch(_){return f;} }
function normalizeUrl(value){ try{const u=new URL(text(value));if(!/^https?:$/.test(u.protocol))return '';u.hash='';return u.toString();}catch(_){return '';} }
function cleanModelText(value){ return text(value).replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim(); }
function tokenUsageGeminiLegacy(raw){ const u=raw?.usageMetadata||{}; return {input:Number(u.promptTokenCount||0),output:Number(u.candidatesTokenCount||0),total:Number(u.totalTokenCount||0)}; }
function tokenUsageGeminiInteraction(raw){ const u=raw?.usage||{}; return {input:Number(u.total_input_tokens||0),output:Number(u.total_output_tokens||0),total:Number(u.total_tokens||0)}; }
function tokenUsageOpenAI(raw){ const u=raw?.usage||{}; return {input:Number(u.input_tokens||0),output:Number(u.output_tokens||0),total:Number(u.total_tokens||0)}; }
function uniqueUrls(values){ return [...new Set((values||[]).map(normalizeUrl).filter(Boolean))]; }
export function aiGatewayId(env){ return text(env?.AI_GATEWAY_ID)||'default'; }
export function gatewayBase(env,provider){ const account=text(env?.AI_GATEWAY_ACCOUNT_ID); if(!account) return ''; return `https://gateway.ai.cloudflare.com/v1/${account}/${encodeURIComponent(aiGatewayId(env))}/${provider}`; }
export function aiGatewayAuthConfigured(env){ return Boolean(text(env?.AI_GATEWAY_TOKEN)); }
export function aiGatewayAuthHeaders(env){ const token=text(env?.AI_GATEWAY_TOKEN); return token?{'cf-aig-authorization':`Bearer ${token}`}:{ }; }
export function geminiConfigured(env){ return Boolean(text(env?.GEMINI_API_KEY)); }
export function workersAiConfigured(env){ return Boolean(env?.AI); }
export function isAiGatewayPreProviderFailure(status,detail){ const s=String(detail||'').toLowerCase(); return (Number(status)===401 && ((s.includes('"code":2009')||s.includes('"internalcode":2009')||s.includes('"name":"aigatewayerror"')))) || (Number(status)===403 && s.includes('1010')); }

export function publicSchemaInstruction(task,missing){
 const matchup=`${text(task.home)} x ${text(task.away)}`;
 const date=text(task.kickoff).slice(0,10);
 const score=(task.home_score!=null&&task.away_score!=null)?`${task.home_score} x ${task.away_score}`:'não informado';
 const round=text(task.round||task.rodada)||'não informada';
 const stadium=text(task.stadium||task.estadio)||'não informado';
 const queries=buildAttendanceSearchQueries(task);
 const homeAliases=teamSearchAliasesNormalized(task.home).join(', ');
 const awayAliases=teamSearchAliasesNormalized(task.away).join(', ');
 const queryPack=queries.join(' ; ');
 const sourcePolicy=attendanceSourcePolicyText(task);
 return `Você é um pesquisador factual de pós-jogo. É OBRIGATÓRIO executar Google Search nesta chamada antes de responder. Pesquise na web APENAS dados documentais da partida ${matchup}. DOSSIÊ: data real=${date}; placar=${score}; rodada=${round}; estádio=${stadium}; event_id=${text(task.event_id)}. Aliases do mandante=${homeAliases}; aliases do visitante=${awayAliases}. Preciso exclusivamente de: ${missing.join(', ')}. Use as combinações de busca a seguir como ponto de partida e REFORMULE se necessário: ${queryPack}. NÃO dependa da expressão literal "${matchup}"; nomes equivalentes dos clubes representam a mesma partida. NÃO estime, NÃO use memória e NÃO confunda com outro confronto/data/rodada. Público = público presente/total; pagantes é campo separado; renda em reais. ${sourcePolicy} Cada número precisa ter sua própria URL realmente encontrada na busca. Se um campo não estiver publicado em fonte aceita, use null.`;
}

// ---------- Gemini generateContent legado (fallback de compatibilidade) ----------
export function geminiGroundingSources(raw){
 const out=[];
 for(const c of raw?.candidates||[]){ for(const ch of c?.groundingMetadata?.groundingChunks||[]){ const u=normalizeUrl(ch?.web?.uri); if(u&&!out.includes(u)) out.push(u); } }
 return out;
}
export function geminiSearchCount(raw){ let n=0; for(const c of raw?.candidates||[]) n += Array.isArray(c?.groundingMetadata?.webSearchQueries)?c.groundingMetadata.webSearchQueries.length:0; return n; }
export function geminiText(raw){ const parts=[]; for(const c of raw?.candidates||[]) for(const p of c?.content?.parts||[]) if(p?.text) parts.push(String(p.text)); return parts.join(''); }

// ---------- Gemini Interactions API: busca observável (payload mínimo documentado) ----------
export function geminiInteractionSearchCount(raw){
  let count=0;
  // Schema atual (maio/2026+): execução observável em steps.
  for(const step of raw?.steps||[]) if(step?.type==='google_search_call') count+=1;
  // Compatibilidade com respostas antigas/transcodificadas por gateways.
  if(count<1) for(const step of raw?.outputs||[]) if(step?.type==='google_search_call') count+=1;
  if(count>0) return count;
  for(const row of raw?.usage?.grounding_tool_count||[]) if(row?.type==='google_search') count+=Number(row?.count||0);
  return count;
}
export function geminiInteractionSources(raw){
  const urls=[];
  const add=(value)=>{const u=normalizeUrl(value);if(u&&!urls.includes(u))urls.push(u);};
  const scan=(steps=[])=>{
    for(const step of steps||[]){
      if(step?.type==='google_search_result'){
        const result=Array.isArray(step?.result)?step.result:[step?.result].filter(Boolean);
        for(const item of result) add(item?.url||item?.uri);
      }
      if(step?.type==='model_output'){
        for(const block of step?.content||[]){
          for(const annotation of block?.annotations||[]) add(annotation?.url||annotation?.uri||annotation?.source||annotation?.url_citation?.url||annotation?.url_citation?.uri);
        }
      }
      // Schema anterior da Interactions API: bloco de texto diretamente em outputs.
      if(step?.type==='text') for(const annotation of step?.annotations||[]) add(annotation?.url||annotation?.uri||annotation?.source||annotation?.url_citation?.url);
    }
  };
  scan(raw?.steps); scan(raw?.outputs);
  return urls;
}
export function geminiInteractionText(raw){
  const parts=[];
  if(typeof raw?.output_text==='string'&&raw.output_text)parts.push(raw.output_text);
  const scan=(steps=[])=>{
    for(const step of steps||[]){
      if(step?.type==='model_output') for(const block of step?.content||[]) if((block?.type==='text'||block?.type==='output_text')&&block?.text)parts.push(String(block.text));
      if((step?.type==='text'||step?.type==='output_text')&&step?.text)parts.push(String(step.text));
    }
  };
  scan(raw?.steps); scan(raw?.outputs);
  return [...new Set(parts)].join('');
}

export function geminiInteractionRequest(task,missing,model='gemini-3.5-flash-lite'){
  // R10R9: Gemini é DESCOBRIDOR DE FONTES, não extrator estruturado.
  // O payload segue a Interactions API atual: google_search + tool_choice no
  // generation_config. A remoção completa de response_format/responseSchema
  // elimina a incompatibilidade HTTP 400 observada em produção no v9 e consolidada no v10.
  return {
    model,
    input: publicSchemaInstruction(task,missing) + ' Sua função nesta etapa é PESQUISAR e citar as melhores URLs encontradas. Não é necessário devolver JSON.',
    tools:[{type:'google_search'}],
    generation_config:{max_output_tokens:600,tool_choice:'any'},
    store:false,
  };
}

function geminiLegacyRequest(task,missing){
  return {
    contents:[{role:'user',parts:[{text:publicSchemaInstruction(task,missing) + ' Execute Google Search e responda com uma síntese factual citando as fontes encontradas. Não use JSON estruturado nesta etapa.'}]}],
    tools:[{google_search:{}}],
    // Fallback legado também opera apenas como descoberta. Sem responseSchema,
    // sem responseMimeType e sem sampling: o parser local faz a extração depois.
    generationConfig:{maxOutputTokens:600},
  };
}

async function fetchGemini(env,url,body,{gateway=false}={}){
  const headers={'content-type':'application/json','x-goog-api-key':text(env.GEMINI_API_KEY)};
  if(gateway) Object.assign(headers,aiGatewayAuthHeaders(env),{'cf-aig-metadata':JSON.stringify({project:'formula-do-gol',component:'postgame',purpose:'attendance-search',provider:'gemini'}),'cf-aig-collect-log-payload':'false','cf-aig-no-wholesale':'true'});
  return fetch(url,{method:'POST',headers,body:JSON.stringify(body)});
}

function retryDirectForGatewayStatus(status,detail=''){
  const n=Number(status||0);
  return isAiGatewayPreProviderFailure(n,detail)||[400,404,405,408,500,502,503,504].includes(n);
}

async function runGeminiCall(env,{url,body,gateway,kind,route,model,task,started}){
  let response=null; let raw=null; let detail=''; let status=null;
  try{
    response=await fetchGemini(env,url,body,{gateway}); status=response.status;
    const rawText=await response.text().catch(()=> '');
    raw=safeJson(rawText,null); detail=text(rawText).slice(0,240);
  }catch(error){ detail=text(error?.message||error).slice(0,240); }
  const searches=kind==='interaction'?geminiInteractionSearchCount(raw):geminiSearchCount(raw);
  const sources=kind==='interaction'?geminiInteractionSources(raw):geminiGroundingSources(raw);
  const output=kind==='interaction'?geminiInteractionText(raw):geminiText(raw);
  const parsed=safeJson(cleanModelText(output),null);
  const usage=kind==='interaction'?tokenUsageGeminiInteraction(raw):tokenUsageGeminiLegacy(raw);
  const ok=Boolean(response?.ok&&raw&&searches>0&&sources.length>0);
  await recordProviderUsage(env,{provider:'gemini',purpose:'postgame_public',eventId:task.event_id,model,phase:'search',searchCalls:searches,inputTokens:usage.input,outputTokens:usage.output,totalTokens:usage.total,responded:Boolean(raw),ok,httpStatus:status,durationMs:Date.now()-started,detail:`${route}:${kind}:searches=${searches}:sources=${sources.length}:${parsed?'json_optional':'discovery_text'}${response?.ok?'':`:http_${status||0}`}`});
  return {response,raw,detail,status,searches,sources,parsed,output,usage,ok,route,kind};
}

export async function searchPublicWithGemini(env,task,missing){
 const model=text(env?.GEMINI_SEARCH_MODEL)||'gemini-3.5-flash-lite';
 if(!geminiConfigured(env)) return {found:false,responded:false,reason:'gemini_not_configured',model,sources:[],searchCalls:0,apiCalls:0,searchObserved:false};
 const directInteractionUrl='https://generativelanguage.googleapis.com/v1beta/interactions';
 const directLegacyUrl=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
 const interactionBody=geminiInteractionRequest(task,missing,model);
 const legacyBody=geminiLegacyRequest(task,missing);
 const started=Date.now();
 const attempts=[];
 let aggregateSources=[]; let parsed=null;

 const run=async(spec)=>{
   const hit=await runGeminiCall(env,{...spec,model,task,started});
   attempts.push(hit); aggregateSources=uniqueUrls([...aggregateSources,...hit.sources]);
   if(hit.parsed) parsed=hit.parsed;
   return hit;
 };

 try{
   // R10R8: Gemini Web Search pula o AI Gateway. Cloudflare documenta o proxy
   // Google AI Studio principalmente para endpoints generateContent; a Interactions
   // API nova é chamada diretamente para eliminar uma camada de incompatibilidade.
   await run({url:directInteractionUrl,body:interactionBody,gateway:false,kind:'interaction',route:'direct_interactions_v10_discovery'});

   let totalSearches=attempts.reduce((sum,a)=>sum+Number(a.searches||0),0);
   // Se a Interactions API falhar, não pesquisar ou não expor nenhuma fonte,
   // tentamos UMA vez o generateContent direto com google_search. Sem sampling.
   if(totalSearches<1||aggregateSources.length<1){
     const last=attempts.at(-1);
     if(Number(last?.status)!==429){
       await run({url:directLegacyUrl,body:legacyBody,gateway:false,kind:'legacy',route:'direct_generateContent_grounding_v10_discovery'});
       totalSearches=attempts.reduce((sum,a)=>sum+Number(a.searches||0),0);
     }
   }

   const apiCalls=attempts.length;
   const responded=attempts.some((a)=>Boolean(a.raw));
   const last=attempts.at(-1)||{};
   const httpFailure=[...attempts].reverse().find((a)=>a.status!=null && !a.response?.ok);
   let reason='';
   if(totalSearches<1){
     const suffix=httpFailure?`:http_${httpFailure.status}:${text(httpFailure.detail).slice(0,260)}`:'';
     reason=`gemini_no_real_search${suffix}`;
   } else if(aggregateSources.length<1) reason='gemini_no_sources';
   else if(parsed?.encontrado===true) reason='';
   else reason='gemini_sources_discovered';
   return {
     // `found` significa apenas que o modelo, opcionalmente, devolveu valores
     // estruturados válidos. No R10R9 a condição principal de sucesso do Gemini
     // é searchCalls>0 + URLs; os números são extraídos depois pelo nosso código.
     found:Boolean(parsed?.encontrado===true),responded,reason,model,parsed,
     sources:aggregateSources,discoveredSources:aggregateSources,
     searchCalls:totalSearches,apiCalls,searchObserved:totalSearches>0,
     route:attempts.map((a)=>a.route).join(' -> '),
     httpStatus:last.status??null,
     attempts:attempts.map((a)=>({route:a.route,kind:a.kind,httpStatus:a.status,searchCalls:a.searches,sources:a.sources.length,parsed:Boolean(a.parsed),error:!a.response?.ok?text(a.detail).slice(0,300):''})),
   };
 }catch(e){
   const detail=text(e?.message||e).slice(0,240);
   return {found:false,responded:false,reason:`gemini_error:${detail}`,model,sources:aggregateSources,discoveredSources:aggregateSources,searchCalls:attempts.reduce((s,a)=>s+Number(a.searches||0),0),apiCalls:attempts.length,searchObserved:false,route:attempts.map((a)=>a.route).join(' -> '),attempts:attempts.map((a)=>({route:a.route,kind:a.kind,httpStatus:a.status,error:text(a.detail).slice(0,300)}))};
 }
}

function htmlToText(html){ return text(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&#39;/g,"'").replace(/&quot;/gi,'"').replace(/\s+/g,' ').slice(0,50000); }

export async function fetchSourceText(url){
 const u=normalizeUrl(url); if(!u) return {ok:false,url:'',text:'',reason:'invalid_url'};
 try{ const r=await fetch(u,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (compatible; FormulaDoGol/1.0; +https://formuladogol.com.br)','accept':'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5','accept-language':'pt-BR,pt;q=0.9,en;q=0.5'}}); if(!r.ok)return{ok:false,url:r.url||u,text:'',reason:`http_${r.status}`}; const type=text(r.headers.get('content-type')); const raw=await r.text(); return {ok:true,url:normalizeUrl(r.url)||u,text:type.includes('html')?htmlToText(raw):text(raw).slice(0,50000)}; }catch(e){return{ok:false,url:u,text:'',reason:`fetch_error:${text(e?.message||e).slice(0,160)}`};}
}

export async function extractPublicWithWorkersAI(env,task,source){
 const model=text(env?.WORKERS_AI_EXTRACT_MODEL)||'@cf/meta/llama-3.1-8b-instruct';
 if(!workersAiConfigured(env)||!source?.text) return {found:false,reason:'workers_ai_unavailable',model};
 const prompt=`Extraia somente dados explícitos deste texto sobre ${text(task.home)} x ${text(task.away)}. Não estime. Retorne APENAS JSON válido: {"encontrado":true|false,"publico":integer|null,"publico_pagante":integer|null,"renda":number|null,"confianca":number}. Público é presença total; pagantes é separado; renda em reais. TEXTO: ${source.text}`;
 const started=Date.now();
 try{
   const raw=await env.AI.run(model,{prompt,max_tokens:500,temperature:0},{gateway:{id:aiGatewayId(env),skipCache:true,collectLog:true,metadata:{project:'formula-do-gol',component:'postgame',purpose:'source-extraction',eventId:text(task.event_id),provider:'workers-ai'}}});
   const answer=cleanModelText(raw?.response||raw?.result?.response||raw?.text||''); const parsed=safeJson(answer,null); const u=raw?.usage||{};
   await recordProviderUsage(env,{provider:'workers-ai',purpose:'postgame_extract',eventId:task.event_id,model,phase:'extract',inputTokens:Number(u.prompt_tokens||u.input_tokens||0),outputTokens:Number(u.completion_tokens||u.output_tokens||0),totalTokens:Number(u.total_tokens||0),responded:true,ok:Boolean(parsed),durationMs:Date.now()-started,detail:parsed?'parsed':'invalid_json'});
   return {found:Boolean(parsed?.encontrado),parsed,model};
 }catch(e){const detail=text(e?.message||e).slice(0,240);await recordProviderUsage(env,{provider:'workers-ai',purpose:'postgame_extract',eventId:task.event_id,model,phase:'extract',responded:false,ok:false,durationMs:Date.now()-started,detail});return{found:false,reason:`workers_ai_error:${detail}`,model};}
}

export function openAiGatewayResponsesUrl(env){ const base=gatewayBase(env,'openai'); return base?`${base}/responses`:'https://api.openai.com/v1/responses'; }
export function openAiUsage(raw){ return tokenUsageOpenAI(raw); }

export async function fetchOpenAiResponses(env,payload,{signal=null,metadata={}}={}){
  const apiKey=text(env?.OPENAI_API_KEY);
  if(!apiKey) throw new Error('openai_key_missing');
  const gatewayUrl=openAiGatewayResponsesUrl(env);
  const viaGateway=gatewayUrl.startsWith('https://gateway.ai.cloudflare.com/');
  const providerHeaders={authorization:`Bearer ${apiKey}`,'content-type':'application/json'};
  const gatewayHeaders={...providerHeaders,...aiGatewayAuthHeaders(env),'cf-aig-metadata':JSON.stringify({project:'formula-do-gol',...metadata,provider:'openai'}),'cf-aig-collect-log-payload':'false','cf-aig-no-wholesale':'true'};
  const body=JSON.stringify(payload);
  let response;
  try{
    response=await fetch(gatewayUrl,{method:'POST',signal,headers:viaGateway?gatewayHeaders:providerHeaders,body});
  }catch(error){
    if(!viaGateway) throw error;
    // Falha de transporte do Gateway não pode impedir a contingência final.
    response=await fetch('https://api.openai.com/v1/responses',{method:'POST',signal,headers:providerHeaders,body});
    return {response,route:'direct_fallback_gateway_network',gatewayFallback:true,gatewayStatus:null,detail:text(error?.message||error).slice(0,400),apiCalls:2};
  }
  if(viaGateway && !response.ok){
    const gatewayStatus=response.status;
    const detail=await response.clone().text().catch(()=> '');
    const retryDirect=isAiGatewayPreProviderFailure(gatewayStatus,detail)||[400,404,405,408,429,500,502,503,504].includes(Number(gatewayStatus));
    if(retryDirect){
      response=await fetch('https://api.openai.com/v1/responses',{method:'POST',signal,headers:providerHeaders,body});
      return {response,route:isAiGatewayPreProviderFailure(gatewayStatus,detail)?'direct_fallback_gateway_preprovider':'direct_fallback_gateway_error',gatewayFallback:true,gatewayStatus,detail:text(detail).slice(0,400),apiCalls:2};
    }
  }
  return {response,route:viaGateway?'ai_gateway':'direct',gatewayFallback:false,apiCalls:1};
}
