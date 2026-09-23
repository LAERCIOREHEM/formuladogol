import { recordProviderUsage } from './ai-usage.js';

function text(v){ return String(v ?? '').trim(); }
function safeJson(v,f=null){ try{return JSON.parse(v);}catch(_){return f;} }
function normalizeUrl(value){ try{const u=new URL(text(value));if(!/^https?:$/.test(u.protocol))return '';u.hash='';return u.toString();}catch(_){return '';} }
function cleanModelText(value){ return text(value).replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim(); }
function tokenUsageGemini(raw){ const u=raw?.usageMetadata||{}; return {input:Number(u.promptTokenCount||0),output:Number(u.candidatesTokenCount||0),total:Number(u.totalTokenCount||0)}; }
function tokenUsageOpenAI(raw){ const u=raw?.usage||{}; return {input:Number(u.input_tokens||0),output:Number(u.output_tokens||0),total:Number(u.total_tokens||0)}; }
export function aiGatewayId(env){ return text(env?.AI_GATEWAY_ID)||'default'; }
export function gatewayBase(env,provider){ const account=text(env?.AI_GATEWAY_ACCOUNT_ID); if(!account) return ''; return `https://gateway.ai.cloudflare.com/v1/${account}/${encodeURIComponent(aiGatewayId(env))}/${provider}`; }
export function aiGatewayAuthConfigured(env){ return Boolean(text(env?.AI_GATEWAY_TOKEN)); }
export function aiGatewayAuthHeaders(env){ const token=text(env?.AI_GATEWAY_TOKEN); return token?{'cf-aig-authorization':`Bearer ${token}`}:{ }; }
export function geminiConfigured(env){ return Boolean(text(env?.GEMINI_API_KEY)); }
export function workersAiConfigured(env){ return Boolean(env?.AI); }
export function isAiGatewayPreProviderFailure(status,detail){ const s=String(detail||'').toLowerCase(); return (Number(status)===401 && ((s.includes('"code":2009')||s.includes('"internalcode":2009')||s.includes('"name":"aigatewayerror"')))) || (Number(status)===403 && s.includes('1010')); }

function publicSchemaInstruction(task,missing){
 const matchup=`${text(task.home)} x ${text(task.away)}`; const date=text(task.kickoff).slice(0,10);
 return `Pesquise na web APENAS dados documentais da partida ${matchup}, em ${date}, event_id ${text(task.event_id)}. Preciso exclusivamente de: ${missing.join(', ')}. Não estime e não use memória. Confirme confronto, data e placar. Público = público presente/total; pagantes é separado. Renda em reais. Priorize clube/CBF/federação, ge, UOL/Estadão e imprensa regional confiável. Se não estiver publicado, use null. Responda SOMENTE JSON válido, sem markdown, neste formato: {"encontrado":true|false,"publico":integer|null,"publico_pagante":integer|null,"renda":number|null,"confianca":number,"observacao":"texto"}.`;
}

export function geminiGroundingSources(raw){
 const out=[];
 for(const c of raw?.candidates||[]){ for(const ch of c?.groundingMetadata?.groundingChunks||[]){ const u=normalizeUrl(ch?.web?.uri); if(u&&!out.includes(u)) out.push(u); } }
 return out;
}
export function geminiSearchCount(raw){ let n=0; for(const c of raw?.candidates||[]) n += Array.isArray(c?.groundingMetadata?.webSearchQueries)?c.groundingMetadata.webSearchQueries.length:0; return n; }
export function geminiText(raw){ const parts=[]; for(const c of raw?.candidates||[]) for(const p of c?.content?.parts||[]) if(p?.text) parts.push(String(p.text)); return parts.join(''); }

async function fetchGemini(env,url,body,{gateway=false}={}){
  const headers={'content-type':'application/json','x-goog-api-key':text(env.GEMINI_API_KEY)};
  if(gateway) Object.assign(headers,aiGatewayAuthHeaders(env),{'cf-aig-metadata':JSON.stringify({project:'formula-do-gol',component:'postgame',purpose:'attendance-search',provider:'gemini'}),'cf-aig-collect-log-payload':'false','cf-aig-no-wholesale':'true'});
  return fetch(url,{method:'POST',headers,body:JSON.stringify(body)});
}

export async function searchPublicWithGemini(env,task,missing){
 const model=text(env?.GEMINI_SEARCH_MODEL)||'gemini-3.5-flash-lite';
 if(!geminiConfigured(env)) return {found:false,responded:false,reason:'gemini_not_configured',model,sources:[]};
 const gateway=gatewayBase(env,'google-ai-studio');
 const gatewayUrl=gateway?`${gateway}/v1beta/models/${encodeURIComponent(model)}:generateContent`:'';
 const directUrl=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
 const body={contents:[{role:'user',parts:[{text:publicSchemaInstruction(task,missing)}]}],tools:[{google_search:{}}],generationConfig:{temperature:0,maxOutputTokens:900}};
 const started=Date.now(); let status=null; let route=gatewayUrl?'ai_gateway':'direct';
 try{
   let r=await fetchGemini(env,gatewayUrl||directUrl,body,{gateway:Boolean(gatewayUrl)});
   status=r.status;
   if(!r.ok && gatewayUrl){
     const detail=await r.text().catch(()=> '');
     if(isAiGatewayPreProviderFailure(r.status,detail)){
       route='direct_fallback_gateway_preprovider';
       r=await fetchGemini(env,directUrl,body,{gateway:false});
       status=r.status;
     }else{
       const raw=safeJson(detail,null); const searches=geminiSearchCount(raw); const usage=tokenUsageGemini(raw);
       await recordProviderUsage(env,{provider:'gemini',purpose:'postgame_public',eventId:task.event_id,model,phase:'search',searchCalls:searches,inputTokens:usage.input,outputTokens:usage.output,totalTokens:usage.total,responded:false,ok:false,httpStatus:status,durationMs:Date.now()-started,detail:`gemini_http_${status}:${text(detail).slice(0,120)}`});
       return {found:false,responded:false,reason:`gemini_http_${status}`,model,sources:[]};
     }
   }
   const raw=await r.json().catch(()=>null); const searches=geminiSearchCount(raw); const usage=tokenUsageGemini(raw);
   if(!r.ok||!raw){ await recordProviderUsage(env,{provider:'gemini',purpose:'postgame_public',eventId:task.event_id,model,phase:'search',searchCalls:searches,inputTokens:usage.input,outputTokens:usage.output,totalTokens:usage.total,responded:false,ok:false,httpStatus:status,durationMs:Date.now()-started,detail:`${route}:gemini_http_${status}`}); return {found:false,responded:false,reason:`gemini_http_${status}`,model,sources:[]}; }
   const parsed=safeJson(cleanModelText(geminiText(raw)),null); const sources=geminiGroundingSources(raw);
   await recordProviderUsage(env,{provider:'gemini',purpose:'postgame_public',eventId:task.event_id,model,phase:'search',searchCalls:searches,inputTokens:usage.input,outputTokens:usage.output,totalTokens:usage.total,responded:true,ok:Boolean(parsed),httpStatus:status,durationMs:Date.now()-started,detail:`${route}:${parsed?'grounded_response':'invalid_json'}`});
   if(!parsed) return {found:false,responded:true,reason:'gemini_invalid_json',model,sources,route};
   return {found:parsed.encontrado===true,responded:true,model,parsed,sources,searchCalls:searches,route};
 }catch(e){ const detail=text(e?.message||e).slice(0,240); await recordProviderUsage(env,{provider:'gemini',purpose:'postgame_public',eventId:task.event_id,model,phase:'search',responded:false,ok:false,httpStatus:status,durationMs:Date.now()-started,detail}); return {found:false,responded:false,reason:`gemini_error:${detail}`,model,sources:[]}; }
}

function htmlToText(html){ return text(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&#39;/g,"'").replace(/&quot;/gi,'"').replace(/\s+/g,' ').slice(0,50000); }

export async function fetchSourceText(url){
 const u=normalizeUrl(url); if(!u) return {ok:false,url:'',text:'',reason:'invalid_url'};
 try{ const r=await fetch(u,{redirect:'follow',headers:{'user-agent':'FormulaDoGolBot/1.0 (+https://formuladogol.com.br)'}}); if(!r.ok)return{ok:false,url:r.url||u,text:'',reason:`http_${r.status}`}; const type=text(r.headers.get('content-type')); const raw=await r.text(); return {ok:true,url:normalizeUrl(r.url)||u,text:type.includes('html')?htmlToText(raw):text(raw).slice(0,50000)}; }catch(e){return{ok:false,url:u,text:'',reason:`fetch_error:${text(e?.message||e).slice(0,160)}`};}
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
  let response=await fetch(gatewayUrl,{method:'POST',signal,headers:viaGateway?gatewayHeaders:providerHeaders,body:JSON.stringify(payload)});
  if(viaGateway && !response.ok){
    const gatewayStatus=response.status;
    const detail=await response.clone().text().catch(()=> '');
    if(isAiGatewayPreProviderFailure(gatewayStatus,detail)){
      response=await fetch('https://api.openai.com/v1/responses',{method:'POST',signal,headers:providerHeaders,body:JSON.stringify(payload)});
      return {response,route:'direct_fallback_gateway_preprovider',gatewayFallback:true,gatewayStatus,detail:text(detail).slice(0,400)};
    }
  }
  return {response,route:viaGateway?'ai_gateway':'direct',gatewayFallback:false};
}
